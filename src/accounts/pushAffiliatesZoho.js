// src/accounts/pushAffiliatesZoho.js

/**
 * Upsert Affiliates into Zoho Accounts (enhanced logging)
 * -------------------------------------------------------
 * Maps affiliates from Galaxy to Zoho Accounts and performs upsert operations.
 * Key fields:
 *  - Trader_ID = AFFILIATES_TRDRID
 *  - Account_Name = AFF_NAME
 *  - Account_AFM = AFF_TIN
 *  - Rev_Number = AFFILIATES_REVNUM
 * Deduplicates by Trader_ID keeping latest Rev_Number.
 * Logs HTTP responses, errors tally, and sample errors for debugging.
 */

const axios = require("axios");
const https = require("https");
const { getZohoAccessToken, getZohoBaseUrl } = require("../auth/zohoAuth");
const cfg = require("../config");

const keepAliveAgent = new https.Agent({ keepAlive: true });
const BATCH_SIZE = 100;

// Helper: Normalize string
const normStr = (v) => (v == null ? undefined : String(v).trim());

// Helper: Normalize ID (uppercase)
const normId = (v) => {
  const s = normStr(v);
  return s ? s.toUpperCase() : undefined;
};

// Helper: Convert to number safely
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Generic Zoho API call wrapper
 * Adds OAuth token, handles keep-alive, disables proxy, and validates status.
 */
async function zohoApi(method, path, body, params) {
  const token = await getZohoAccessToken();
  const base = getZohoBaseUrl();
  const url = `${base}${path}`;
  return axios({
    method,
    url,
    data: body,
    params,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "Content-Type": "application/json",
    },
    timeout: cfg.timeoutMs,
    decompress: true,
    validateStatus: () => true,
    proxy: false,
    httpsAgent: keepAliveAgent,
  });
}

/**
 * Map Galaxy affiliate row to Zoho account fields
 */
function mapAffToZohoAccount(row) {
  return {
    Trader_ID: normId(row?.AFFILIATES_TRDRID),
    Account_Name: normStr(row?.AFF_NAME),
    Account_AFM: normStr(row?.AFF_TIN),
    Rev_Number: num(row?.AFFILIATES_REVNUM),
    __GX_AFF_TRDRID: normId(row?.AFFILIATES_TRDRID),
  };
}

/**
 * Upsert affiliates and return Zoho ID map: Trader_ID -> ZohoID
 * Logs HTTP status, tally of errors, and sample errors for debugging.
 */
async function upsertAffiliates(affRows, { debug } = {}) {
  const mappedAll = (Array.isArray(affRows) ? affRows : []).map(
    mapAffToZohoAccount
  );

  // Deduplicate by Trader_ID keeping latest Rev_Number
  const byTrader = new Map();
  for (const rec of mappedAll) {
    if (!rec.Trader_ID || !rec.Account_Name) continue;
    const prev = byTrader.get(rec.Trader_ID);
    if (!prev || (num(rec.Rev_Number) || 0) > (num(prev.Rev_Number) || 0)) {
      byTrader.set(rec.Trader_ID, rec);
    }
  }
  const mapped = Array.from(byTrader.values());
  console.log(
    `[AFF->ZOHO] Affiliates mapped (unique by Trader_ID): ${mapped.length}`
  );

  if (debug) {
    const sample = mapped.slice(0, 5).map((x) => ({
      Trader_ID: x.Trader_ID,
      Account_Name: x.Account_Name,
      Rev_Number: x.Rev_Number,
    }));
    console.log("[AFF->ZOHO] Sample mapped:", sample);
  }

  if (!mapped.length)
    return { success: 0, failed: 0, idByTraderId: new Map(), details: [] };

  let success = 0,
    failed = 0;
  const details = [];
  const idByTraderId = new Map();

  // Split into batches
  const groups = Array.from(
    { length: Math.ceil(mapped.length / BATCH_SIZE) },
    (_, i) => mapped.slice(i * BATCH_SIZE, i * BATCH_SIZE + BATCH_SIZE)
  );

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    const res = await zohoApi(
      "POST",
      "/crm/v8/Accounts/upsert",
      { data: group },
      { duplicate_check_fields: "Trader_ID" }
    );

    const httpStatus = res.status;
    const body = res.data;

    if (httpStatus !== 200 || !Array.isArray(body?.data)) {
      failed += group.length;
      console.warn(
        `[AFF->ZOHO] Upsert batch ${gi + 1}/${
          groups.length
        } HTTP ${httpStatus}. Body:`,
        body
      );
      details.push({ status: "http_error", httpStatus, payload: body });
      continue;
    }

    const errorTally = new Map();
    const sampleErrors = [];

    for (let i = 0; i < body.data.length; i++) {
      const rowRes = body.data[i];
      const sent = group[i];

      if (rowRes.status === "success") {
        success += 1;
        const zid = rowRes.details?.id;
        if (zid && sent?.Trader_ID) idByTraderId.set(sent.Trader_ID, zid);
        details.push({
          status: "success",
          action: rowRes.action,
          id: zid,
          trader: sent?.Trader_ID,
        });
      } else {
        failed += 1;
        const code = rowRes.code || "UNKNOWN";
        const msg = rowRes.message || "";
        const d = rowRes.details || null;
        details.push({
          status: "error",
          code,
          message: msg,
          details: d,
          trader: sent?.Trader_ID,
        });

        errorTally.set(code, (errorTally.get(code) || 0) + 1);
        if (sampleErrors.length < 5) {
          sampleErrors.push({ code, message: msg, details: d });
        }
      }
    }

    if (errorTally.size) {
      console.warn(
        `[AFF->ZOHO] Batch ${gi + 1}/${groups.length} — errors by code:`,
        Object.fromEntries(errorTally.entries())
      );
      console.warn(
        `[AFF->ZOHO] Batch ${gi + 1}/${groups.length} — sample errors:`,
        sampleErrors
      );
    } else {
      console.log(
        `[AFF->ZOHO] Batch ${gi + 1}/${groups.length} — all ${
          group.length
        } records succeeded.`
      );
    }
  }

  console.log(
    `[AFF->ZOHO] Upsert result → success: ${success}, failed: ${failed}, idMap size: ${idByTraderId.size}`
  );
  if (debug) {
    const sample = Array.from(idByTraderId.entries()).slice(0, 5);
    console.log("[AFF->ZOHO] Sample Trader_ID→ZohoID:", sample);
  }

  return { success, failed, idByTraderId, details };
}

module.exports = { upsertAffiliates };

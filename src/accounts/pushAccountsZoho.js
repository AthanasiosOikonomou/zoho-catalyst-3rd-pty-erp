/**
 * Zoho Accounts Integration (Upsert-only, no COQL)
 * ------------------------------------------------
 * - Maps Galaxy customers to Zoho Accounts
 * - Upserts all via /crm/v8/Accounts/upsert with duplicate_check_fields=Trader_ID
 * - (Kept) getMaxZohoRevNumber() for watermark
 */

const axios = require("axios");
const https = require("https");
const { getZohoAccessToken, getZohoBaseUrl } = require("../auth/zohoAuth");
const cfg = require("../config");

const keepAliveAgent = new https.Agent({ keepAlive: true });
const BATCH_SIZE = 200;

// ---------- normalization helpers ----------
const normStr = (v) => (v == null ? undefined : String(v).trim());
const normId = (v) => {
  const s = normStr(v);
  return s ? s.toUpperCase() : undefined;
};
const normDigits = (v) => {
  if (v == null) return undefined;
  const s = String(v).replace(/\D+/g, "");
  return s.length ? s : undefined;
};
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const normPhone = (v) => {
  if (!v) return null;
  let s = String(v)
    .trim()
    .replace(/[.\-\s()]/g, "");
  if (!/^\+?\d{8,15}$/.test(s)) return null;
  return s;
};

// ---------- Zoho API helper ----------
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

// ---------- mapper (Galaxy -> Zoho Accounts) ----------
function mapGalaxyToZohoAccount(gx) {
  const name =
    normStr(gx.TRDRNAME) ||
    normStr(gx.COMPTITLE) ||
    normStr(gx.CUSTCODE) ||
    normStr(gx.TRDRCODE);

  const tinDigits = normDigits(gx.TIN);

  return {
    Trader_ID: normId(gx.TRDRID),
    Account_Name: name,
    Account_AFM: tinDigits,
    Phone: normPhone(gx.TRDSPHONE1),
    Billing_Street: normStr(gx.TRDSSTREET),
    Shipping_Street: normStr(gx.TRDSSTREET),
    Billing_State: normStr(gx.PREFDESCR),
    Shipping_State: normStr(gx.PREFDESCR),
    Billing_Country: normStr(gx.CNTRCODE),
    Shipping_Country: normStr(gx.CNTRCODE),
    Industry: normStr(gx.CAT_EPAGG),
    Account_Category: normStr(gx.CATEGDISCOUNT),
    Credit_Limit: num(gx.BALANCE),
    Open_Balance: num(gx.MAXBALANCE),
    Watt: num(gx.WATT_CY),
    Turnover_YTD: num(gx.TURNOVER_YTD),
    Turnover_LTD: num(gx.TURNOVER_LTD),
    Turnover_LY: num(gx.TURVOVER_LY),
    Rev_Number: num(gx.THIRDPARTYREVNUM),
    SALESNAME: normStr(gx.SALESNAME),
    __GX_TRDRID: normId(gx.TRDRID),
    __GX_TIN: tinDigits,
    __GX_NAME: name,
  };
}

/**
 * Fetch the maximum Rev_Number from Zoho Accounts.
 * (Kept from the previous version; efficient for watermarking.)
 */
async function getMaxZohoRevNumber() {
  try {
    const res = await zohoApi("GET", "/crm/v2/Accounts", null, {
      fields: "Rev_Number",
      sort_by: "Rev_Number",
      sort_order: "desc",
      per_page: 1,
      page: 1,
    });

    if (res.status !== 200) {
      console.log(
        `[ZOHO] Max Rev Fetch failed (status ${res.status}). Response:`,
        res.data
      );
      return 0;
    }

    const records = Array.isArray(res.data?.data) ? res.data.data : [];
    if (records.length > 0) {
      const rev = Number(records[0].Rev_Number);
      return Number.isFinite(rev) ? rev : 0;
    }
    return 0;
  } catch (err) {
    console.error(
      "[ZOHO] Max Rev Fetch API call error:",
      err.message || String(err)
    );
    return 0;
  }
}

/**
 * Upsert Accounts.
 * - affiliateIdByCustomerTrdrId: Map<customer TRDRID, affiliate Zoho ID>
 */
async function upsertAccounts(
  galaxyItems,
  { debug, affiliateIdByCustomerTrdrId } = {}
) {
  const totalIn = Array.isArray(galaxyItems) ? galaxyItems.length : 0;
  console.log(`[ZOHO] upsertAccounts() received ${totalIn} galaxy item(s).`);

  // Map and filter invalids
  const mapped = [];
  let dropped = 0;
  for (const gx of Array.isArray(galaxyItems) ? galaxyItems : []) {
    const m = mapGalaxyToZohoAccount(gx);
    if (!m.Account_Name) {
      dropped++;
      if (process.env.DEBUG === "1") {
        console.warn("[ZOHO] Dropping item with no Account_Name", {
          Trader_ID: m.__GX_TRDRID,
          TIN: m.__GX_TIN,
          Name: m.__GX_NAME,
        });
      }
      continue;
    }
    if (!m.Trader_ID) {
      dropped++;
      if (process.env.DEBUG === "1") {
        console.warn("[ZOHO] Dropping item with no Trader_ID", {
          Trader_ID: m.__GX_TRDRID,
          Name: m.__GX_NAME,
        });
      }
      continue;
    }

    // Inject affiliate lookup if we have it for this customer TRDRID
    if (affiliateIdByCustomerTrdrId && m.Trader_ID) {
      const affZohoId = affiliateIdByCustomerTrdrId.get(m.Trader_ID);
      if (affZohoId) {
        m.Affiliate_To = { id: affZohoId }; // lookup to Accounts
      }
    }

    // Remove internal debug fields before send
    delete m.__GX_TRDRID;
    delete m.__GX_TIN;
    delete m.__GX_NAME;

    mapped.push(m);
  }

  console.log(`[ZOHO] Mapped ${mapped.length} item(s). Dropped: ${dropped}.`);
  if (!mapped.length) {
    return { success: 0, failed: 0, details: [], debug: { dropped } };
  }

  // Batch upsert only
  const groups = Array.from(
    { length: Math.ceil(mapped.length / BATCH_SIZE) },
    (_, i) => mapped.slice(i * BATCH_SIZE, i * BATCH_SIZE + BATCH_SIZE)
  );

  let success = 0,
    failed = 0;
  const details = [];

  const results = await Promise.all(
    groups.map((group) =>
      zohoApi(
        "POST",
        "/crm/v8/Accounts/upsert",
        { data: group },
        { duplicate_check_fields: "Trader_ID" }
      )
    )
  );

  for (let gi = 0; gi < results.length; gi++) {
    const res = results[gi];
    const group = groups[gi];

    if (res.status !== 200 || !Array.isArray(res.data?.data)) {
      failed += group.length;
      details.push({
        status: "http_error",
        httpStatus: res.status,
        payload: res.data,
      });
      continue;
    }
    for (const row of res.data.data) {
      if (row.status === "success") {
        success += 1;
        details.push({
          status: "success",
          action: row.action,
          id: row.details?.id,
        });
      } else {
        failed += 1;
        details.push({
          status: "error",
          code: row.code,
          message: row.message,
          details: row.details,
        });
      }
    }
  }

  const out = { success, failed, details };
  if (debug) out.debug = { dropped };
  return out;
}

module.exports = {
  upsertAccounts,
  mapGalaxyToZohoAccount,
  getMaxZohoRevNumber,
};

/**
 * Zoho Accounts Integration (Upsert-only, with Affiliate_To, enhanced logging)
 */

const axios = require("axios");
const https = require("https");
const { getZohoAccessToken, getZohoBaseUrl } = require("../auth/zohoAuth");
const cfg = require("../config");

const keepAliveAgent = new https.Agent({ keepAlive: true });
// Many Zoho APIs cap at 100 records per call. Keep it safe.
const BATCH_SIZE = 100;

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

function mapGalaxyToZohoAccount(gx) {
  const name =
    normStr(gx.TRDRNAME) ||
    normStr(gx.COMPTITLE) ||
    normStr(gx.CUSTCODE) ||
    normStr(gx.TRDRCODE);

  const tinDigits = normDigits(gx.TIN);
  const revNum = num(gx.THIRDPARTYREVNUM);

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
    // Use the calculated revNum value
    Rev_Number: revNum,
    SALESNAME: normStr(gx.SALESNAME),

    // temp debug helpers (removed before send)
    __GX_TRDRID: normId(gx.TRDRID),
    __GX_TIN: tinDigits,
    __GX_NAME: name,
    // NEW: Debug helper for the Rev_Number used for linking
    __GX_REVNUM: revNum,
  };
}

/**
 * Efficient watermark for Galaxy.
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
 * Upsert Accounts with optional Affiliate_To lookup (by Rev_Number).
 * Enhanced logging: HTTP status, error tallies, and sample errors.
 *
 * @param {Array<Object>} galaxyItems
 * @param {{ debug?: boolean, affiliateIdByCustomerRevNum?: Map<number,string>, affiliateFieldApiName?: string }} options
 */
async function upsertAccounts(
  galaxyItems,
  // Changed expected map to affiliateIdByCustomerRevNum
  {
    debug,
    affiliateIdByCustomerRevNum,
    affiliateFieldApiName = "Affiliate_To",
  } = {}
) {
  const totalIn = Array.isArray(galaxyItems) ? galaxyItems.length : 0;
  console.log(`[ZOHO] upsertAccounts() received ${totalIn} galaxy item(s).`);

  const mapped = [];
  let dropped = 0;
  let affiliateAttachedCount = 0;
  const affiliateAttachSamples = [];

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

    // Attach Affiliate lookup if available (NOW LINKING BY Rev_Number)
    if (affiliateIdByCustomerRevNum && m.Rev_Number) {
      const affZohoId = affiliateIdByCustomerRevNum.get(m.Rev_Number);
      if (affZohoId) {
        m[affiliateFieldApiName] = { id: affZohoId };
        affiliateAttachedCount++;
        if (affiliateAttachSamples.length < 5) {
          affiliateAttachSamples.push({
            Rev_Number: m.Rev_Number,
            [affiliateFieldApiName]: affZohoId,
          });
        }
      }
    }

    // Remove internal debug fields
    delete m.__GX_TRDRID;
    delete m.__GX_TIN;
    delete m.__GX_NAME;
    delete m.__GX_REVNUM; // NEW: remove Rev_Number debug field

    mapped.push(m);
  }

  console.log(`[ZOHO] Mapped ${mapped.length} item(s). Dropped: ${dropped}.`);
  console.log(
    `[ZOHO] Affiliate lookups attached: ${affiliateAttachedCount}${
      affiliateAttachSamples.length
        ? " (sample: " + JSON.stringify(affiliateAttachSamples) + ")"
        : ""
    }`
  );

  if (!mapped.length) {
    return {
      success: 0,
      failed: 0,
      details: [],
      debug: { dropped, affiliateAttachedCount },
    };
  }

  const groups = Array.from(
    { length: Math.ceil(mapped.length / BATCH_SIZE) },
    (_, i) => mapped.slice(i * BATCH_SIZE, i * BATCH_SIZE + BATCH_SIZE)
  );

  let success = 0,
    failed = 0;
  const details = [];

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
        `[ZOHO] Upsert batch ${gi + 1}/${
          groups.length
        } HTTP ${httpStatus}. Body:`,
        body
      );
      details.push({ status: "http_error", httpStatus, payload: body });
      continue;
    }

    // Tally error codes, collect sample errors
    const errorTally = new Map();
    const sampleErrors = [];

    for (let i = 0; i < body.data.length; i++) {
      const row = body.data[i];
      if (row.status === "success") {
        success += 1;
        details.push({
          status: "success",
          action: row.action,
          id: row.details?.id,
        });
      } else {
        failed += 1;
        const code = row.code || "UNKNOWN";
        const msg = row.message || "";
        const d = row.details || null;
        details.push({ status: "error", code, message: msg, details: d });

        errorTally.set(code, (errorTally.get(code) || 0) + 1);
        if (sampleErrors.length < 5) {
          sampleErrors.push({ code, message: msg, details: d });
        }
      }
    }

    // Print a compact summary for this batch
    if (errorTally.size) {
      console.warn(
        `[ZOHO] Batch ${gi + 1}/${groups.length} — errors by code:`,
        Object.fromEntries(errorTally.entries())
      );
      console.warn(
        `[ZOHO] Batch ${gi + 1}/${groups.length} — sample errors:`,
        sampleErrors
      );
    } else {
      console.log(
        `[ZOHO] Batch ${gi + 1}/${groups.length} — all ${
          group.length
        } records succeeded.`
      );
    }
  }

  const out = { success, failed, details };
  // Changed debug key to reflect the new map key
  if (debug)
    out.debug = { dropped, affiliateAttachedCount, affiliateAttachSamples };
  return out;
}

module.exports = {
  upsertAccounts,
  mapGalaxyToZohoAccount,
  getMaxZohoRevNumber,
};

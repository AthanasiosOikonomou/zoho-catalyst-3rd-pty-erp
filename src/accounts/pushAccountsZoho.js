// src/accounts/pushAccountsZoho.js

/**
 * Zoho Accounts Integration
 * --------------------------
 * Provides utilities to:
 *  - Normalize Galaxy records into Zoho Accounts format
 *  - Retrieve the latest revision watermark from Zoho
 *  - Upsert Accounts into Zoho CRM (with optional Affiliate_To linking)
 *
 * Notes:
 *  - Upsert only (no delete)
 *  - Supports batch processing with logging and error aggregation
 *  - Affiliate linking is based on Rev_Number if mapping is provided
 */

const axios = require("axios");
const https = require("https");
const { getZohoAccessToken, getZohoBaseUrl } = require("../auth/zohoAuth");
const cfg = require("../config");

const keepAliveAgent = new https.Agent({ keepAlive: true });
// Many Zoho APIs cap at 100 records per call. Keep it safe.
const BATCH_SIZE = 100;

// Normalization helpers — sanitize and standardize Galaxy values before mapping
// - Strings: trim, uppercase, or undefined
// - Digits: strip non-numeric
// - Numbers: parse or undefined
// - Phone: strict validation (E.164-like, 8–15 digits)

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

/**
 * Generic Zoho API request wrapper.
 * Handles token injection, JSON headers, timeout, compression, and keep-alive.
 * Returns raw Axios response without throwing on non-200 status.
 *
 * @param {"GET"|"POST"|"PUT"|"DELETE"} method
 * @param {string} path - API endpoint path (relative to base URL).
 * @param {Object|null} body - Request payload (if any).
 * @param {Object} params - Query string params.
 * @returns {Promise<AxiosResponse>}
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
 * Map a single Galaxy customer record into Zoho Accounts format.
 * Applies normalization to ensure consistent IDs, numbers, and phone formats.
 *
 * - Uses Trader_ID as the unique external key
 * - Attempts multiple fallbacks for Account_Name
 * - Includes financial and turnover fields if available
 * - Attaches Rev_Number for watermark tracking
 * - Temporary debug fields (__GX_*) are added for diagnostics and later stripped
 *
 * @param {Object} gx - Galaxy customer record
 * @returns {Object} Normalized Zoho Account record
 */

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
 * Fetch the highest Rev_Number currently stored in Zoho Accounts.
 * Used as a watermark for incremental sync from Galaxy.
 *
 * @returns {Promise<number>} The latest Rev_Number, or 0 on error/empty.
 */

async function getMaxZohoRevNumber() {
  try {
    /**
     * Fetch single record sorted by Rev_Number descending
     * use v2 because v8 does not support sorting
     * https://www.zoho.com/crm/developer/docs/api/v2/get-records.html
     * sort_by: string, optional
     * Specify the API name of the field based on which the records must be sorted. The default value is id. If you provide invalid values, default sorting will take
     * Possible values: Field API names
     * v3 up to v8 do not support sort_by by custom fields
     */
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
 * Upsert Galaxy records into Zoho Accounts.
 *
 * - Groups records into batches of 100 (Zoho API limit)
 * - Drops items missing mandatory fields (Trader_ID, Account_Name)
 * - Optionally links Affiliate_To field if a Rev_Number → Zoho ID map is provided
 * - Logs progress: batch results, error tallies, sample errors
 *
 * @param {Array<Object>} galaxyItems - Raw Galaxy records to process
 * @param {Object} options
 * @param {boolean} [options.debug] - Include debug info in return object
 * @param {Map<number,string>} [options.affiliateIdByCustomerRevNum] - Map of Rev_Number → Affiliate Zoho ID
 * @param {string} [options.affiliateFieldApiName="Affiliate_To"] - Field API name for affiliate link
 * @returns {Promise<{ success:number, failed:number, details:Array, debug?:Object }>}
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
      if (IS_DEBUG) {
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
      if (IS_DEBUG) {
        console.warn("[ZOHO] Dropping item with no Trader_ID", {
          Trader_ID: m.__GX_TRDRID,
          Name: m.__GX_NAME,
        });
      }
      continue;
    }

    // Attach Affiliate lookup if a matching Rev_Number is found

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

    // Clean up temp debug fields
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

    // Aggregate errors by code and capture up to 5 samples for diagnostics

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

/**
 * Zoho Accounts Integration Module
 * --------------------------------
 * Provides functions for mapping Galaxy customer data to Zoho Accounts format,
 * performing batch upsert/update operations, and retrieving watermarks from Zoho CRM.
 * Handles API communication, data normalization, and error handling.
 */

const axios = require("axios");
const { getZohoAccessToken, getZohoBaseUrl } = require("../auth/zohoAuth");
const cfg = require("../config");

// Utility functions for data normalization.
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
 * Maps a Galaxy customer object to Zoho Account fields.
 * Handles normalization and field mapping.
 * @param {Object} gx - Galaxy customer object.
 * @returns {Object} Zoho Account payload.
 */
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

// NOTE: Using 200 as the Zoho batch size limit. Can be increased up to 200 for faster processing.
const BATCH_SIZE = 200;
// Utility to split arrays into chunks for batch processing.
const chunk = (arr, n) =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) =>
    arr.slice(i * n, i * n + n)
  );

/**
 * Makes an authenticated Zoho API call.
 * @param {string} method - HTTP method.
 * @param {string} path - API endpoint path.
 * @param {Object|null} body - Request body.
 * @param {Object|null} params - Query parameters.
 * @returns {Promise<AxiosResponse>} API response.
 */
async function zohoApi(method, path, body, params) {
  const token = await getZohoAccessToken();
  const base = getZohoBaseUrl();
  const url = `${base}${path}`;
  // KeepAlive agents removed for quick job termination
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
  });
}

/**
 * Searches Zoho Accounts using COQL to find existing records by Trader_ID.
 * @param {string[]} ids - Array of Trader_ID values to search for.
 * @returns {Promise<Map<string, string>>} Map of Trader_ID -> Zoho ID.
 */
async function mapExistingByTraderId(ids) {
  const out = new Map();
  const vals = ids.filter(Boolean);
  if (!vals.length) return out;

  // Format Trader IDs for IN clause in COQL: ('ID1', 'ID2', ...)
  const formattedIds = vals
    .map((v) => `'${String(v).replace(/'/g, "\\'")}'`)
    .join(", ");

  // Query remains unchanged
  const selectQuery = `select id, Trader_ID from Accounts where Trader_ID in (${formattedIds})`;

  const coqlBody = {
    select_query: selectQuery,
  };

  try {
    const res = await zohoApi("POST", "/crm/v8/coql", coqlBody, null);

    if (res.status === 200 && Array.isArray(res.data?.data)) {
      for (const rec of res.data.data) {
        const traderId = normId(rec.Trader_ID);
        const zohoId = rec.id;
        if (traderId && zohoId) out.set(traderId, zohoId);
      }
    } else if (process.env.DEBUG === "1") {
      console.warn(`[ZOHO] COQL search failed -> ${res.status}`, res.data);
    }
  } catch (err) {
    console.error("[ZOHO] COQL API call error:", err.message);
  }

  return out;
}

/**
 * Retrieves the maximum Rev_Number from Zoho Accounts in a single efficient API call.
 * Used for watermarking and incremental sync.
 * @returns {Promise<number>} The maximum Rev_Number, or 0 if none found.
 */
async function getMaxZohoRevNumber() {
  try {
    // 1. Order by Rev_Number descending, and fetch only 1 record
    const res = await zohoApi("GET", "/crm/v2/Accounts", null, {
      fields: "Rev_Number",
      sort_by: "Rev_Number",
      sort_order: "desc",
      per_page: 1, // Only need the top record
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

    return 0; // No records found
  } catch (err) {
    console.error(
      "[ZOHO] Max Rev Fetch API call error:",
      err.message || String(err)
    );
    return 0;
  }
}

/**
 * Splits mapped records into update and insert groups based on existence in Zoho.
 * Removes internal fields not meant for Zoho API payload.
 * @param {Array<Object>} mapped - Array of mapped Zoho Account objects.
 * @returns {Object} { toUpdate, toInsert }
 */
function splitUpdatesInserts(mapped) {
  const toUpdate = [];
  const toInsert = [];
  for (const r of mapped) {
    const payload = { ...r };
    // Delete internal fields not meant for Zoho API payload
    delete payload.__GX_TRDRID;
    delete payload.__GX_TIN;
    delete payload.__GX_NAME;

    // CRITICAL: The internal __matchId is extracted
    const matchId = payload.__matchId;
    delete payload.__matchId;

    if (matchId) {
      // For UPDATES (Zoho API PUT), the payload MUST include the Zoho 'id'
      toUpdate.push({ id: matchId, ...payload });
    } else {
      // For INSERTS/UPSERTS (Zoho API POST), the payload MUST NOT include the 'id'
      toInsert.push(payload);
    }
  }
  return { toUpdate, toInsert };
}

/**
 * Performs batch update of Zoho Accounts using PUT requests.
 * Processes results and aggregates success/failure counts.
 * @param {Array<Object>} records - Records to update.
 * @returns {Promise<Object>} Update result summary.
 */
async function batchUpdateAccounts(records) {
  let success = 0,
    failed = 0,
    details = [];

  // OPTIMIZATION: Prepare all API calls and run them in parallel
  const apiPromises = chunk(records, BATCH_SIZE).map((group) =>
    zohoApi("PUT", "/crm/v8/Accounts", { data: group })
  );
  const allResults = await Promise.all(apiPromises);

  // Process results from all concurrent calls
  for (const res of allResults) {
    // Determine how many records were in this group to accurately count failures
    const groupSize = Array.isArray(res.data?.data)
      ? res.data.data.length
      : res.config.data
      ? JSON.parse(res.config.data).data.length
      : BATCH_SIZE;

    if (res.status !== 200 || !Array.isArray(res.data?.data)) {
      failed += groupSize;
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
  return { success, failed, details };
}

/**
 * Performs batch insert/upsert of Zoho Accounts using POST requests.
 * Processes results and aggregates success/failure counts.
 * @param {Array<Object>} records - Records to insert/upsert.
 * @returns {Promise<Object>} Insert result summary.
 */
async function batchInsertOrUpsertAccounts(records) {
  let success = 0,
    failed = 0,
    details = [];

  // OPTIMIZATION: Prepare all API calls and run them in parallel
  const apiPromises = chunk(records, BATCH_SIZE).map((group) =>
    zohoApi(
      "POST",
      "/crm/v8/Accounts/upsert",
      { data: group },
      { duplicate_check_fields: "Trader_ID" }
    )
  );
  const allResults = await Promise.all(apiPromises);

  // Process results from all concurrent calls
  for (const res of allResults) {
    // Determine how many records were in this group to accurately count failures
    const groupSize = Array.isArray(res.data?.data)
      ? res.data.data.length
      : res.config.data
      ? JSON.parse(res.config.data).data.length
      : BATCH_SIZE;

    if (res.status !== 200 || !Array.isArray(res.data?.data)) {
      failed += groupSize;
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
  return { success, failed, details };
}

/**
 * Main function to upsert Galaxy customer items into Zoho Accounts.
 * Handles mapping, duplicate detection, batch update/insert, and result aggregation.
 * @param {Array<Object>} galaxyItems - Array of Galaxy customer objects.
 * @param {Object} options - Options (e.g., debug).
 * @returns {Promise<Object>} Upsert result summary.
 */
async function upsertAccounts(galaxyItems, { debug } = {}) {
  const totalIn = Array.isArray(galaxyItems) ? galaxyItems.length : 0;
  console.log(`[ZOHO] upsertAccounts() received ${totalIn} galaxy item(s).`);
  const mappedAll = (Array.isArray(galaxyItems) ? galaxyItems : []).map(
    mapGalaxyToZohoAccount
  );

  const mapped = [];
  let dropped = 0;
  for (const m of mappedAll) {
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
    // CRITICAL: Must have Trader_ID to proceed with single-field matching
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
    mapped.push(m);
  }
  console.log(`[ZOHO] Mapped ${mapped.length} item(s). Dropped: ${dropped}.`);
  if (mapped.length === 0) {
    return {
      success: 0,
      failed: 0,
      details: [],
      debug: { toUpdate: 0, toInsert: 0, dropped },
    };
  }

  // --- SEARCH BY TRADER_ID USING COQL (Single API call) ---
  const traderIds = mapped.map((x) => x.Trader_ID);
  console.log(
    `[ZOHO] Starting COQL lookup of ${traderIds.length} Trader_ID(s) in Zoho.`
  );

  const byTraderId = await mapExistingByTraderId(traderIds);
  for (const r of mapped) {
    const id = r.Trader_ID ? byTraderId.get(r.Trader_ID) : undefined;
    if (id) r.__matchId = id;
  }
  // --- END OF SEARCH ---

  const { toUpdate, toInsert } = splitUpdatesInserts(mapped);
  console.log(
    `[ZOHO] Prepared toUpdate=${toUpdate.length}, toInsert=${toInsert.length}`
  );

  // 1. Update existing records found by COQL
  const upd = toUpdate.length
    ? await batchUpdateAccounts(toUpdate)
    : { success: 0, failed: 0, details: [] };

  // 2. Insert/Upsert new records, relying on Zoho's duplicate check for Trader_ID
  const ins = toInsert.length
    ? await batchInsertOrUpsertAccounts(toInsert)
    : { success: 0, failed: 0, details: [] };

  const result = {
    success: upd.success + ins.success,
    failed: upd.failed + ins.failed,
    details: [...upd.details, ...ins.details],
  };
  if (debug)
    result.debug = {
      toUpdate: toUpdate.length,
      toInsert: toInsert.length,
      dropped,
    };
  return result;
}

module.exports = {
  upsertAccounts,
  mapGalaxyToZohoAccount,
  getMaxZohoRevNumber,
};

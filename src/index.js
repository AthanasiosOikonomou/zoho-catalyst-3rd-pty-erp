// src/index.js

/**
 * Catalyst Job Entry Point
 * ------------------------
 * Linking Strategy: Affiliates are linked to Customers if they share the same Rev_Number.
 * CRITICAL FIX: The minRev for fetching affiliates and the RevNum Set for filtering are
 * derived ONLY from customers that have a ZH_CUSTOMERS_MEMBER_CARDNO (Card No),
 * based on the assumption that only cardholders have affiliate relationships.
 */

const cfg = require("./config");
const { authenticate } = require("./auth/auth.js");
const { createApiClient } = require("./api/apiClient");
const { fetchGalaxyData } = require("./accounts/fetchAccountsGlx.js");
const SessionStore = require("./utils/sessionStore");
const {
  upsertAccounts,
  getMaxZohoRevNumber,
} = require("./accounts/pushAccountsZoho.js");
const { fetchAffiliatesSince } = require("./accounts/fetchAffiliatesGlx.js");
const { upsertAffiliates } = require("./accounts/pushAffiliatesZoho.js");

// -------- helpers --------

/**
 * Parse FETCH_SINCE_REV override from environment or use max Zoho watermark.
 * If FETCH_ALL=1, always start from 0.
 */
function parseSinceRevOverride(maxZohoRev) {
  if (String(process.env.FETCH_ALL || "").trim() === "1") return 0;
  const raw = process.env.FETCH_SINCE_REV;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
    console.warn(
      `[STATE] Ignoring invalid FETCH_SINCE_REV="${raw}". Using watermark ${maxZohoRev}.`
    );
  }
  return maxZohoRev;
}

/**
 * Determine DEV_LIMIT for slicing customer batches.
 * Supports multiple env variants (DEV_LIMIT, dev_limit, Dev_Limit, DEV_ONE_ITEM)
 */
function computeDevLimit() {
  const rawUpper = process.env.DEV_LIMIT;
  const rawLower = process.env.dev_limit;
  const rawMixed = process.env.Dev_Limit;

  const candidates = [rawUpper, rawLower, rawMixed].filter(
    (v) => v !== undefined
  );
  for (const v of candidates) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) {
      console.log(
        `[DEV] ENV DEV_LIMIT=${rawUpper ?? ""} dev_limit=${
          rawLower ?? ""
        } Dev_Limit=${rawMixed ?? ""} DEV_ONE_ITEM=${
          process.env.DEV_ONE_ITEM ?? ""
        } → using devLimit=${n}`
      );
      return n;
    }
  }
  const one = process.env.DEV_ONE_ITEM === "1" ? 1 : 0;
  console.log(
    `[DEV] ENV DEV_LIMIT=${rawUpper ?? ""} dev_limit=${
      rawLower ?? ""
    } Dev_Limit=${rawMixed ?? ""} DEV_ONE_ITEM=${
      process.env.DEV_ONE_ITEM ?? ""
    } → using devLimit=${one}`
  );
  return one;
}

/**
 * Uppercase helper
 */
function upper(s) {
  return String(s || "").toUpperCase();
}

/**
 * Build Affiliate maps:
 * - affRevToAffTrader: AFFILIATES_REVNUM -> {affTraderId, rev}
 * - byAffTrader: Trader_ID -> chosen row (for upsert)
 * Deduplicates affiliates by Trader_ID and groups by RevNum for linking.
 */
function buildAffiliateMaps(allAffRows) {
  const affRevToAffTrader = new Map(); // AFFILIATES_REVNUM -> { affTraderId, rev }
  const byAffTrader = new Map(); // affiliate Trader_ID -> chosen row (for upsert)

  for (const row of allAffRows || []) {
    const affRev = Number(row?.AFFILIATES_REVNUM) || 0;
    const affTrader = upper(row?.AFFILIATES_TRDRID || "");
    if (!affRev || !affTrader) continue;

    // 1. Group by Affiliate Rev Number (for Customer linking):
    // Choose the LATEST affiliate (by its own AFFILIATES_REVNUM) for a given AFFILIATES_REVNUM group.
    const prevAffRev = affRevToAffTrader.get(affRev);
    if (!prevAffRev || affRev > (prevAffRev.rev || 0)) {
      affRevToAffTrader.set(affRev, { affTraderId: affTrader, rev: affRev });
    }

    // 2. Deduplicate for Upserting:
    // Deduplicate affiliates by their Trader_ID (as before) to prepare for upsert.
    const prevAff = byAffTrader.get(affTrader);
    if (!prevAff || affRev > (Number(prevAff?.AFFILIATES_REVNUM) || 0)) {
      byAffTrader.set(affTrader, row);
    }
  }

  console.log(
    `[AFFILIATES] Built RevNum→affiliate map: ${affRevToAffTrader.size} entries.`
  );
  const uniqueAffRows = Array.from(byAffTrader.values());
  console.log(
    `[AFFILIATES] Unique affiliate rows (before batch filter): ${uniqueAffRows.length}`
  );

  if (IS_DEBUG) {
    const sampleRevNum = Array.from(affRevToAffTrader.entries()).slice(0, 5);
    const sampleAff = uniqueAffRows.slice(0, 5).map((r) => ({
      AFFILIATES_TRDRID: r.AFFILIATES_TRDRID,
      AFF_NAME: r.AFF_NAME,
      AFFILIATES_REVNUM: r.AFFILIATES_REVNUM,
    }));
    console.log("[AFFILIATES] Sample RevNum→affiliate (link):", sampleRevNum);
    console.log(
      "[AFFILIATES] Sample unique affiliates (before filter):",
      sampleAff
    );
  }

  return { affRevToAffTrader, uniqueAffRows };
}

// -------- main run --------

async function runJobOnce() {
  console.log("[JOB] Start", new Date().toISOString());

  const sessionStore = new SessionStore(cfg.sessionFile);
  if (cfg.ssPid && !sessionStore.getSsPid()) {
    sessionStore.setAll({ ssPid: cfg.ssPid });
  }
  const api = createApiClient(() => sessionStore.getSessionId());

  async function doAuthAndPersist() {
    const currentPid = sessionStore.getSsPid();
    const { sessionId, ssPid } = await authenticate(currentPid);
    sessionStore.setAll({ sessionId, ssPid });
    console.log("[AUTH] Stored sessionId" + (ssPid ? " and ssPid" : "") + ".");
  }

  async function ensureSession() {
    if (!sessionStore.getSessionId()) await doAuthAndPersist();
  }

  await ensureSession();

  // 1) Watermark from Zoho
  const maxZohoRev = await getMaxZohoRevNumber();
  console.log(
    `[STATE] Max Zoho Rev_Number (COQL source of truth): ${maxZohoRev}`
  );

  // 2) Backfill override (FETCH_ALL / FETCH_SINCE_REV)
  const sinceRev = parseSinceRevOverride(maxZohoRev);
  if (sinceRev !== maxZohoRev) {
    console.log(
      `[STATE] Overriding watermark: sinceRev=${sinceRev} (was ${maxZohoRev})`
    );
  }

  // 3) Fetch Galaxy customers above sinceRev
  let res;
  try {
    res = await fetchGalaxyData(
      api,
      "/api/glx/views/Customer/custom/zh_Customers_fin",
      sinceRev
    );
  } catch (err) {
    console.error(
      `[FETCH ERROR] Failed at stage fetch:first. Network/Connection Issue:`,
      err
    );
    return {
      ok: false,
      stage: "fetch:first",
      error: err?.message || String(err),
    };
  }

  const s1 = typeof res?.status === "number" ? res.status : -1;
  if (s1 === 401 || s1 === 403) {
    console.warn(`[AUTH] Session invalid (status ${s1}). Re-authenticating...`);
    await doAuthAndPersist();
    try {
      res = await fetchGalaxyData(
        api,
        "/api/glx/views/Customer/custom/zh_Customers_fin",
        sinceRev
      );
    } catch (err) {
      console.error(
        `[FETCH ERROR] Failed at stage fetch:reauth. Network/Connection Issue:`,
        err
      );
      return {
        ok: false,
        stage: "fetch:reauth",
        error: err?.message || String(err),
      };
    }
  }

  if (!res || typeof res.status !== "number") {
    return {
      ok: false,
      stage: "fetch:bad-response",
      error: "No/invalid response object from Galaxy",
    };
  }
  if (res.status < 200 || res.status >= 300) {
    const bodyMsg = JSON.stringify(res.data) || "No response body";
    console.error(
      `[FETCH ERROR] Galaxy API failed. Status: ${res.status} ${res.statusText}. Response Body: ${bodyMsg}`
    );
    return {
      ok: false,
      stage: "fetch:http",
      status: res.status,
      statusText: res.statusText,
      message: bodyMsg,
    };
  }

  const fullItems = Array.isArray(res.data?.Items) ? res.data.Items : [];
  console.log(`[CUSTOMERS] Received ${fullItems.length} item(s).`);

  // 4) DEV slicing
  const devLimit = computeDevLimit();
  const items = devLimit > 0 ? fullItems.slice(0, devLimit) : fullItems;
  console.log(`[DEV] Using ${items.length} item(s) after DEV_LIMIT slicing.`);

  if (!items.length) {
    console.log("[CUSTOMERS] No items to process after slicing.");
    return {
      ok: true,
      processed: 0,
      success: 0,
      failed: 0,
      affiliatesFetched: 0,
      affiliatesUpserted: 0,
    };
  }

  // CRITICAL: Collect THIRDPARTYREVNUMs and full data ONLY from customers with a CardNo
  const cardHolderRevNums = [];
  const cardHolderCustomerSamples = [];
  for (const it of items) {
    if (
      it?.ZH_CUSTOMERS_MEMBER_CARDNO != null &&
      it.ZH_CUSTOMERS_MEMBER_CARDNO !== ""
    ) {
      const rev = Number(it.THIRDPARTYREVNUM);
      if (Number.isFinite(rev) && rev > 0) {
        cardHolderRevNums.push(rev);
        cardHolderCustomerSamples.push(it); // Store the full object for diagnostic logging
      }
    }
  }

  console.log(
    `[REV NUM] In sliced batch: ${cardHolderRevNums.length} item(s) with CardNo and RevNum.`
  );

  // *** DIAGNOSTIC LOGGING: Dump the data used for linking ***
  if (cardHolderCustomerSamples.length > 0) {
    console.log(
      "[DIAGNOSTIC] CARD-HOLDER CUSTOMER DATA DUMP (CHECK FOR LINKING ID):",
      cardHolderCustomerSamples.slice(0, 5)
    );
  }

  // *** NEW STEP: Create a Set of Rev_Numbers from the Card-Holding customers (for filtering) ***
  const batchRevNumSet = new Set(cardHolderRevNums);

  // 5) Affiliates: single call with minRev from card-holding customers
  let affiliatesFetched = 0;
  let affiliatesUpserted = 0;
  let affiliateIdByCustomerRevNum = new Map();

  let minRev = sinceRev; // Start with the global watermark/override
  if (cardHolderRevNums.length) {
    const minRevInBatch = Math.min(...cardHolderRevNums);
    minRev =
      sinceRev === 0 || minRevInBatch < sinceRev ? minRevInBatch : sinceRev;
  }

  console.log(`[AFFILIATES] Determined affiliate fetch minRev: ${minRev}.`);

  // ---- Single attempt: minRev determined by batch
  const affRes = await fetchAffiliatesSince(api, minRev, {
    timeoutMs: 20000,
    retry: 1,
  });
  let allAff = [];
  if (affRes?.status >= 200 && affRes.status < 300) {
    allAff = Array.isArray(affRes.data?.Items) ? affRes.data.Items : [];
    affiliatesFetched += allAff.length;
    console.log(
      `[AFFILIATES] minRev=${minRev} → fetched ${allAff.length} row(s).`
    );
  } else {
    console.warn(
      `[AFFILIATES] HTTP ${affRes?.status || "??"} on affiliate fetch.`
    );
  }

  const { affRevToAffTrader, uniqueAffRows } = buildAffiliateMaps(allAff);

  // *** FILTER: Restrict unique affiliates to only those whose RevNum matches a CardHolder's RevNum in the batch ***
  const relevantAffiliatesToUpsert = uniqueAffRows.filter((affRow) =>
    batchRevNumSet.has(Number(affRow.AFFILIATES_REVNUM))
  );

  console.log(
    `[AFFILIATES] Filtering unique affiliates from ${uniqueAffRows.length} to ${relevantAffiliatesToUpsert.length} based on batch RevNum match.`
  );

  // Upsert ONLY the filtered, relevant affiliates
  const affUp = await upsertAffiliates(relevantAffiliatesToUpsert, {
    debug: IS_DEBUG,
  });
  affiliatesUpserted = affUp.success;
  const idByTraderId = affUp.idByTraderId || new Map();

  // New Linking Step: RevNum -> Affiliate Zoho ID (Only map if the affiliate was successfully upserted)
  affiliateIdByCustomerRevNum = new Map();
  for (const [revNum, { affTraderId }] of affRevToAffTrader.entries()) {
    const zid = idByTraderId.get(affTraderId);
    if (zid) affiliateIdByCustomerRevNum.set(revNum, zid);
  }

  console.log(
    `[AFFILIATES] Ready for linking: Customer RevNum→affiliate ZohoID map size: ${affiliateIdByCustomerRevNum.size}`
  );
  if (IS_DEBUG) {
    const sample = Array.from(affiliateIdByCustomerRevNum.entries()).slice(
      0,
      5
    );
    console.log(
      "[AFFILIATES] Sample Customer RevNum → affiliate ZohoID:",
      sample
    );
  }

  // 6) Upsert customers with Affiliate_To lookup where available
  console.log(`[ZOHO] Calling upsert for ${items.length} item(s)...`);
  const up = await upsertAccounts(items, {
    debug: IS_DEBUG,
    affiliateIdByCustomerRevNum,
  });
  console.log(`[ZOHO] Upsert → success: ${up.success}, failed: ${up.failed}`);

  return {
    ok: true,
    processed: items.length,
    success: up.success,
    failed: up.failed,
    affiliatesFetched,
    affiliatesUpserted,
    linkedCustomers: affiliateIdByCustomerRevNum.size,
  };
}

// -------- export job --------

module.exports = async (params, context) => {
  try {
    const result = await runJobOnce();
    if (result.ok) {
      console.log("[JOB] Logic successful. Signaling completion.");
      context.closeWithSuccess();
    } else {
      console.log(`[JOB] Logic failed at stage: ${result.stage}`);
      context.closeWithFailure();
    }
    return result;
  } catch (error) {
    console.error("[JOB FATAL ERROR]", error.message);
    context.closeWithFailure();
    return { ok: false, stage: "fatal", error: error.message };
  }
};

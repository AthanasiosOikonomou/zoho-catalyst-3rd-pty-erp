/**
 * Catalyst Job Entry Point (optimized)
 * -----------------------------------
 * Flow:
 * 1) Ensure Galaxy session
 * 2) Get max Rev_Number from Zoho (watermark)
 * 3) Fetch Galaxy customers > watermark
 * 4) From those with member card -> minRev -> fetch affiliates
 * 5) Upsert affiliates to Zoho, capture idByTraderId
 * 6) Build customer->affiliate Zoho ID map
 * 7) Upsert customers (setting Affiliate_To lookup)
 */

const cfg = require("./config");
const { authenticate } = require("./auth/auth.js");
const { createApiClient } = require("./api/apiClient");
const { fetchGalaxyData } = require("./accounts/fetchAccountsZoho.js");
const SessionStore = require("./utils/sessionStore");
const {
  upsertAccounts,
  getMaxZohoRevNumber,
} = require("./accounts/pushAccountsZoho.js");
const { fetchAffiliatesSince } = require("./accounts/fetchAffiliates.js");
const { upsertAffiliates } = require("./accounts/pushAffiliatesZoho.js");

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

  // 2) Fetch Galaxy customers above watermark
  let res;
  try {
    res = await fetchGalaxyData(
      api,
      "/api/glx/views/Customer/custom/zh_Customers_fin",
      maxZohoRev
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
        maxZohoRev
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
  if (fullItems.length === 0) {
    console.log("[CUSTOMERS] No new/updated items.");
    return {
      ok: true,
      processed: 0,
      success: 0,
      failed: 0,
      affiliatesFetched: 0,
      affiliatesUpserted: 0,
    };
  }

  // 3) Collect rev nums for member-card accounts, compute min
  const memberCardRevNums = [];
  for (let i = 0; i < fullItems.length; i++) {
    const it = fullItems[i];
    if (
      it?.ZH_CUSTOMERS_MEMBER_CARDNO != null &&
      it.ZH_CUSTOMERS_MEMBER_CARDNO !== ""
    ) {
      const rev = Number(it.THIRDPARTYREVNUM);
      if (Number.isFinite(rev)) memberCardRevNums.push(rev);
    }
  }
  if (process.env.DEBUG === "1")
    console.log(`[MEMBER CARD] count=${memberCardRevNums.length}`);

  // Prepare affiliates fetch (lazy; only if we have member-card rows)
  let affiliatesPromise = null;
  if (memberCardRevNums.length) {
    let minRev = memberCardRevNums[0];
    for (let i = 1; i < memberCardRevNums.length; i++)
      if (memberCardRevNums[i] < minRev) minRev = memberCardRevNums[i];
    affiliatesPromise = fetchAffiliatesSince(api, minRev).catch((e) => ({
      err: e,
    }));
  }

  // Optional DEV slicing
  const devLimit =
    process.env.DEV_ONE_ITEM === "1" ? 1 : Number(process.env.DEV_LIMIT || 0);
  const items = devLimit > 0 ? fullItems.slice(0, devLimit) : fullItems;

  // 4) Resolve affiliates, upsert affiliates, build linking maps
  let affiliatesFetched = 0;
  let affiliatesUpserted = 0;
  let affiliateIdByCustomerTrdrId = new Map();

  if (affiliatesPromise) {
    const affRes = await affiliatesPromise;
    if (affRes?.err) {
      console.error(
        "[AFFILIATES] fetch error:",
        affRes.err?.message || String(affRes.err)
      );
    } else if (affRes?.status >= 200 && affRes.status < 300) {
      const affItems = Array.isArray(affRes.data?.Items)
        ? affRes.data.Items
        : [];
      affiliatesFetched = affItems.length;
      if (process.env.DEBUG === "1") {
        console.log(`[AFFILIATES] fetched items=${affiliatesFetched}`);
      }

      // Build customer->affiliateTrader map by latest AFFILIATES_REVNUM
      const custToAffTrader = new Map(); // key: customer TRDRID, val: { affTraderId, rev }
      for (const row of affItems) {
        const custId = (
          row?.AFFILIATES_CUST_TRDRID ||
          row?.TRDRID ||
          ""
        ).toUpperCase();
        const affTrader = (row?.AFFILIATES_TRDRID || "").toUpperCase();
        const rev = Number(row?.AFFILIATES_REVNUM) || 0;
        if (!custId || !affTrader) continue;

        const prev = custToAffTrader.get(custId);
        if (!prev || rev > (prev.rev || 0)) {
          custToAffTrader.set(custId, { affTraderId: affTrader, rev });
        }
      }

      // Deduplicate affiliates by Trader and keep latest rev
      const byAffTrader = new Map(); // affTraderId -> bestRow
      for (const row of affItems) {
        const affTrader = (row?.AFFILIATES_TRDRID || "").toUpperCase();
        if (!affTrader) continue;
        const rev = Number(row?.AFFILIATES_REVNUM) || 0;
        const prev = byAffTrader.get(affTrader);
        if (!prev || rev > (prev.AFFILIATES_REVNUM || 0)) {
          byAffTrader.set(affTrader, row);
        }
      }
      const uniqueAffRows = Array.from(byAffTrader.values());

      // Upsert affiliates first, get idByTraderId
      const affUp = await upsertAffiliates(uniqueAffRows, {
        debug: process.env.DEBUG === "1",
      });
      affiliatesUpserted = affUp.success;
      const idByTraderId = affUp.idByTraderId || new Map();

      // Build final map: customer TRDRID -> affiliate Zoho ID (if we have it)
      affiliateIdByCustomerTrdrId = new Map();
      for (const [custId, { affTraderId }] of custToAffTrader.entries()) {
        const zid = idByTraderId.get(affTraderId);
        if (zid) affiliateIdByCustomerTrdrId.set(custId, zid);
      }
    } else {
      console.warn(`[AFFILIATES] HTTP ${affRes?.status || "??"}`);
    }
  }

  // 5) Upsert customers, injecting Affiliate_To where available
  console.log(`[ZOHO] Calling upsert for ${items.length} item(s)...`);
  const up = await upsertAccounts(items, {
    debug: process.env.DEBUG === "1",
    affiliateIdByCustomerTrdrId,
  });
  console.log(`[ZOHO] Upsert → success: ${up.success}, failed: ${up.failed}`);

  return {
    ok: true,
    processed: items.length,
    success: up.success,
    failed: up.failed,
    affiliatesFetched,
    affiliatesUpserted,
  };
}

// Catalyst job export
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

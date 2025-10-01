/**
 * Catalyst Job Entry Point (affiliates per-customer, DEV_LIMIT respected)
 */

const cfg = require("./config");
const { authenticate } = require("./auth/auth.js");
const { createApiClient } = require("./api/apiClient");
const { fetchGalaxyData } = require("./utils/fetchDataGlx.js");
const SessionStore = require("./utils/sessionStore");
const {
  upsertAccounts,
  getMaxZohoRevNumber,
} = require("./accounts/pushAccountsZoho.js");
const {
  fetchAffiliatesForCustomers,
} = require("./accounts/fetchAffiliates.js");
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

  // 3) DEV slicing must happen BEFORE any affiliates logic
  const devLimit =
    process.env.DEV_ONE_ITEM === "1" ? 1 : Number(process.env.DEV_LIMIT || 0);
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

  // 4) From *sliced* customers, find those with member cards
  const customersWithMemberCard = items
    .filter(
      (it) =>
        it?.ZH_CUSTOMERS_MEMBER_CARDNO != null &&
        it.ZH_CUSTOMERS_MEMBER_CARDNO !== ""
    )
    .map((it) => String(it.TRDRID || "").toUpperCase())
    .filter(Boolean);

  console.log(
    `[MEMBER CARD] Customers with card in this batch: ${
      customersWithMemberCard.length
    }${
      customersWithMemberCard.length
        ? " → " + customersWithMemberCard.slice(0, 5).join(", ")
        : ""
    }`
  );

  // 5) Fetch affiliates per-customer (limited concurrency)
  let affiliatesFetched = 0;
  let affiliatesUpserted = 0;
  let affiliateIdByCustomerTrdrId = new Map();

  if (customersWithMemberCard.length) {
    const { items: affItems, stats } = await fetchAffiliatesForCustomers(
      api,
      customersWithMemberCard,
      {
        timeoutMs: 20000,
        retry: 1,
        concurrency: 3,
      }
    );
    affiliatesFetched = affItems.length;
    console.log(
      `[AFFILIATES] Fetch aggregated: for ${stats.totalCustomers} customers → succeeded=${stats.succeeded}, failed=${stats.failed}, totalItems=${affiliatesFetched}`
    );

    // Build customer→affiliate (keep latest by REVNUM)
    const custToAffTrader = new Map();
    for (const row of affItems) {
      const custId = String(
        row?.AFFILIATES_CUST_TRDRID || row?.TRDRID || ""
      ).toUpperCase();
      const affTrader = String(row?.AFFILIATES_TRDRID || "").toUpperCase();
      const rev = Number(row?.AFFILIATES_REVNUM) || 0;
      if (!custId || !affTrader) continue;

      const prev = custToAffTrader.get(custId);
      if (!prev || rev > (prev.rev || 0)) {
        custToAffTrader.set(custId, { affTraderId: affTrader, rev });
      }
    }
    console.log(
      `[AFFILIATES] Built customer→affiliate map: ${custToAffTrader.size} entries.`
    );
    if (process.env.DEBUG === "1") {
      const sample = Array.from(custToAffTrader.entries()).slice(0, 5);
      console.log("[AFFILIATES] Sample customer→affiliate:", sample);
    }

    // Deduplicate affiliates by Trader_ID (keep latest by REVNUM)
    const byAffTrader = new Map();
    for (const row of affItems) {
      const affTrader = String(row?.AFFILIATES_TRDRID || "").toUpperCase();
      if (!affTrader) continue;
      const rev = Number(row?.AFFILIATES_REVNUM) || 0;
      const prev = byAffTrader.get(affTrader);
      if (!prev || rev > (prev.AFFILIATES_REVNUM || 0)) {
        byAffTrader.set(affTrader, row);
      }
    }
    const uniqueAffRows = Array.from(byAffTrader.values());
    console.log(
      `[AFFILIATES] Unique affiliate rows to upsert: ${uniqueAffRows.length}`
    );

    // 6) Upsert affiliates first
    const affUp = await upsertAffiliates(uniqueAffRows, {
      debug: process.env.DEBUG === "1",
    });
    affiliatesUpserted = affUp.success;
    const idByTraderId = affUp.idByTraderId || new Map();

    // Build final map: customer TRDRID -> affiliate Zoho ID
    affiliateIdByCustomerTrdrId = new Map();
    for (const [custId, { affTraderId }] of custToAffTrader.entries()) {
      const zid = idByTraderId.get(affTraderId);
      if (zid) affiliateIdByCustomerTrdrId.set(custId, zid);
    }
    console.log(
      `[AFFILIATES] Ready for linking: customer→affiliate ZohoID map size: ${affiliateIdByCustomerTrdrId.size}`
    );
    if (process.env.DEBUG === "1") {
      const sample = Array.from(affiliateIdByCustomerTrdrId.entries()).slice(
        0,
        5
      );
      console.log(
        "[AFFILIATES] Sample customer TRDRID → affiliate ZohoID:",
        sample
      );
    }
  } else {
    console.log(
      "[AFFILIATES] No member-card customers in this batch; skip affiliates flow."
    );
  }

  // 7) Upsert customers with Affiliate_To lookup when available
  console.log(`[ZOHO] Calling upsert for ${items.length} item(s)...`);
  const up = await upsertAccounts(items, {
    debug: process.env.DEBUG === "1",
    affiliateIdByCustomerTrdrId,
  });
  console.log(`[ZOHO] Upsert → success: ${up.success}, failed: ${up.failed}`);

  // Return summary
  return {
    ok: true,
    processed: items.length,
    success: up.success,
    failed: up.failed,
    affiliatesFetched,
    affiliatesUpserted,
    linkedCustomers: affiliateIdByCustomerTrdrId.size,
  };
}

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

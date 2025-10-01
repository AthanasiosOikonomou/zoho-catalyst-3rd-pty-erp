/**
 * Catalyst Job Entry Point
 * ------------------------
 * Orchestrates the end-to-end workflow for synchronizing customer data between
 * Galaxy and Zoho CRM. Handles authentication, session management, error handling,
 * and upsert operations. Designed to run as a scheduled Catalyst job.
 */

const cfg = require("./config");
const { authenticate } = require("./auth/auth.js");
const { createApiClient } = require("./api/apiClient");
const {
  fetchGalaxyData,
  maxThirdPartyRevNum,
} = require("./utils/fetchDataGlx.js");
const SessionStore = require("./utils/sessionStore");
const {
  upsertAccounts,
  getMaxZohoRevNumber,
} = require("./accounts/pushAccountsZoho.js"); // RevStore import removed
// src/index.js
const { fetchAffiliatesSince } = require("./accounts/fetchAffiliates.js");

/**
 * Main job logic executed once per run.
 * Handles session initialization, authentication, data fetching, error handling,
 * and upserting customer records to Zoho.
 * @returns {Promise<Object>} Job result summary.
 */
async function runJobOnce() {
  console.log("[JOB] Start", new Date().toISOString());

  const sessionStore = new SessionStore(cfg.sessionFile);
  if (cfg.ssPid && !sessionStore.getSsPid()) {
    sessionStore.setAll({ ssPid: cfg.ssPid });
  }
  const api = createApiClient(() => sessionStore.getSessionId());

  // RevStore is no longer used.

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

  // 1. Get the current high watermark directly from Zoho CRM via COQL
  const maxZohoRev = await getMaxZohoRevNumber();
  console.log(
    `[STATE] Max Zoho Rev_Number (COQL source of truth): ${maxZohoRev}`
  );

  let res;
  try {
    res = await fetchGalaxyData(
      api,
      "/api/glx/views/Customer/custom/zh_Customers_fin",
      maxZohoRev
    );
  } catch (err) {
    // ⚡️ FIX 1: Log the error object directly here to capture network issues (timeouts, SSL errors)
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
      // ⚡️ FIX 2: Log re-authentication fetch failure
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
    const status = res.status;
    const statusText = res.statusText || "Unknown";
    // ⚡️ FIX 3: Log the response data on HTTP error (like 400)
    const bodyMsg = JSON.stringify(res.data) || "No response body";

    console.error(
      `[FETCH ERROR] Galaxy API failed. Status: ${status} ${statusText}. Response Body: ${bodyMsg}`
    );

    return {
      ok: false,
      stage: "fetch:http",
      status: status,
      statusText: statusText,
      message: bodyMsg,
    };
  }

  const fullItems = Array.isArray(res.data?.Items) ? res.data.Items : [];
  console.log(`[CUSTOMERS] Received ${fullItems.length} item(s).`);

  if (fullItems.length === 0) {
    console.log("[CUSTOMERS] No new/updated items.");
    return { ok: true, processed: 0, success: 0, failed: 0 };
  }

  // NEW: collect rev nums for member-card holders (1 pass, tiny logs)
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
  if (process.env.DEBUG === "1") {
    console.log(`[MEMBER CARD] count=${memberCardRevNums.length}`);
  }

  let affiliatesCount = 0;
  if (memberCardRevNums.length) {
    // compute once, O(n) and fastest for JS engines
    let minRev = memberCardRevNums[0];
    for (let i = 1; i < memberCardRevNums.length; i++) {
      const v = memberCardRevNums[i];
      if (v < minRev) minRev = v;
    }

    try {
      const affRes = await fetchAffiliatesSince(api, minRev);
      if (affRes?.status >= 200 && affRes.status < 300) {
        const affItems = Array.isArray(affRes.data?.Items)
          ? affRes.data.Items
          : [];
        affiliatesCount = affItems.length;
        if (process.env.DEBUG === "1") {
          console.log(
            `[AFFILIATES] minRev=${minRev} -> items=${affiliatesCount}`
          );
        }
        // Optional: do something with affItems (e.g., map or upsert)
      } else {
        // keep logs short unless debugging
        if (process.env.DEBUG === "1") {
          console.warn(`[AFFILIATES] HTTP ${affRes?.status}`, affRes?.data);
        } else {
          console.warn(`[AFFILIATES] HTTP ${affRes?.status || "??"}`);
        }
      }
    } catch (err) {
      // network or unexpected
      console.error("[AFFILIATES] fetch error:", err?.message || String(err));
    }
  } else if (process.env.DEBUG === "1") {
    console.log(
      "[MEMBER CARD] No member-card accounts in this batch; skipping affiliates fetch."
    );
  }

  const devLimit =
    process.env.DEV_ONE_ITEM === "1" ? 1 : Number(process.env.DEV_LIMIT || 0);
  const items = devLimit > 0 ? fullItems.slice(0, devLimit) : fullItems;

  console.log(`[ZOHO] Calling upsert for ${items.length} item(s)...`);
  const up = await upsertAccounts(items, { debug: process.env.DEBUG === "1" });
  console.log(`[ZOHO] Upsert → success: ${up.success}, failed: ${up.failed}`);

  // 3. No need to update any persistence store (RevStore logic removed).
  // The next run will query Zoho again for the new maximum.

  return {
    ok: true,
    processed: items.length,
    success: up.success,
    failed: up.failed,
    affiliatesFetched: affiliatesCount,
  };
}

// ---- Catalyst JOB export ----
/**
 * Catalyst job export function.
 * Handles job lifecycle, result reporting, and error signaling to Catalyst context.
 * @param {Object} params - Job parameters.
 * @param {Object} context - Catalyst job context for signaling completion/failure.
 * @returns {Promise<Object>} Job result.
 */
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

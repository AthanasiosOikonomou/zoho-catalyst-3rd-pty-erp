/**
 * Catalyst Job Entry Point for Quotes/Offers
 */

const cfg = require("./config");
const { authenticate } = require("./auth/auth.js"); // Reused
const { createApiClient } = require("./api/apiClient"); // Reused
const SessionStore = require("./utils/sessionStore"); // Reused

// NEW REQUIRES FOR QUOTES
const {
  fetchGalaxyOffers,
  fetchQuoteLines,
} = require("./offers/fetchQuotesZoho.js");
const {
  getMaxZohoQuoteRevNumber,
  getAccountIdsByTin,
  ensureProducts,
  upsertQuotes,
} = require("./offers/pushQuotesZoho.js");

// -------- helpers (parseSinceRevOverride, computeDevLimit, upper are reused) --------

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

  // 1) Watermark from Zoho Quotes (NEW)
  const maxZohoRev = await getMaxZohoQuoteRevNumber();
  console.log(`[STATE] Max Zoho Quote Rev_Number: ${maxZohoRev}`);

  // 2) Backfill override (FETCH_ALL / FETCH_SINCE_REV)
  const sinceRev = parseSinceRevOverride(maxZohoRev);
  if (sinceRev !== maxZohoRev) {
    console.log(
      `[STATE] Overriding watermark: sinceRev=${sinceRev} (was ${maxZohoRev})`
    );
  }

  // 3) Fetch Galaxy Offers above sinceRev (NEW)
  let res;
  try {
    res = await fetchGalaxyOffers(api, sinceRev);
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

  // Re-auth logic if session failed
  const s1 = typeof res?.status === "number" ? res.status : -1;
  if (s1 === 401 || s1 === 403) {
    console.warn(`[AUTH] Session invalid (status ${s1}). Re-authenticating...`);
    await doAuthAndPersist();
    try {
      res = await fetchGalaxyOffers(api, sinceRev);
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

  if (
    !res ||
    typeof res.status !== "number" ||
    res.status < 200 ||
    res.status >= 300
  ) {
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

  const fullOffers = Array.isArray(res.data?.Items) ? res.data.Items : [];
  console.log(`[QUOTES] Received ${fullOffers.length} offer(s).`);

  // 4) DEV slicing
  const devLimit = computeDevLimit();
  const offers = devLimit > 0 ? fullOffers.slice(0, devLimit) : fullOffers;
  console.log(`[DEV] Using ${offers.length} offer(s) after DEV_LIMIT slicing.`);

  if (!offers.length) {
    console.log("[QUOTES] No offers to process after slicing.");
    return { ok: true, processed: 0 };
  }

  // 5) Collect TINS for customer lookup
  const custTins = offers.map((o) => o.CUST_TIN).filter((t) => t);

  // 6) Customer Lookup: CUST_TIN -> Zoho Account ID
  const accountIdByTin = await getAccountIdsByTin(custTins);
  console.log(
    `[QUOTES] Found Zoho IDs for ${accountIdByTin.size} out of ${custTins.length} unique TINS.`
  );

  // 7) Fetch Quote Lines (Subform data)
  const quoteLinesByOfferId = new Map();
  let allQuoteLines = [];

  for (const offer of offers) {
    const offerId = offer.ID;
    // Skip fetching lines if the customer isn't in Zoho (the quote will be skipped later anyway)
    const tin = offer.CUST_TIN;
    if (!accountIdByTin.has(tin)) continue;

    try {
      const lineRes = await fetchQuoteLines(api, offerId);
      const lines = Array.isArray(lineRes.data?.Items)
        ? lineRes.data.Items
        : [];
      quoteLinesByOfferId.set(offerId, lines);
      allQuoteLines.push(...lines);
    } catch (err) {
      console.error(
        `[FETCH ERROR] Failed to fetch lines for offer ID ${offerId.slice(
          0,
          8
        )}...`,
        err?.message
      );
      quoteLinesByOfferId.set(offerId, []);
    }
  }
  console.log(
    `[QUOTES] Fetched lines for ${quoteLinesByOfferId.size} offers. Total lines: ${allQuoteLines.length}.`
  );

  // 8) Product Sync: Ensure all products in the lines exist in Zoho (NEW)
  const productIdByCode = await ensureProducts(allQuoteLines);

  // 9) Upsert Quotes
  console.log(`[ZOHO] Calling upsert for ${offers.length} quote item(s)...`);
  const up = await upsertQuotes(
    offers,
    quoteLinesByOfferId,
    accountIdByTin,
    productIdByCode
  );
  console.log(`[ZOHO] Upsert → success: ${up.success}, failed: ${up.failed}`);

  return {
    ok: true,
    processed: offers.length,
    success: up.success,
    failed: up.failed,
    quotesFetched: fullOffers.length,
    linesFetched: allQuoteLines.length,
    customersFound: accountIdByTin.size,
    productsSynced: productIdByCode.size,
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

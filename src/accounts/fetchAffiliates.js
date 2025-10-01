// src/accounts/fetchAffiliates.js
const { buildRawFilter } = require("../utils/filters");

/**
 * Build a Galaxy filter for exact match on AFFILIATES_CUST_TRDRID.
 */
function filterByCustomerTrdr(custTrdrId) {
  // [{AFFILIATES_CUST_TRDRID:["<id>",Equal]}]
  return buildRawFilter("AFFILIATES_CUST_TRDRID", String(custTrdrId), "Equal");
}

/**
 * Single affiliates request by customer TRDRID, with per-call timeout override and one retry.
 * @param {AxiosInstance} api
 * @param {string} custTrdrId
 * @param {{ timeoutMs?: number, retry?: number }} options
 * @returns {Promise<Array<Object>>} affiliate Items for that customer
 */
async function fetchAffiliatesByCustomer(
  api,
  custTrdrId,
  { timeoutMs = 20000, retry = 1 } = {}
) {
  const path = "/api/glx/views/Customer/custom/ZH_AFFILIATE";
  const filters = filterByCustomerTrdr(custTrdrId);
  const finalUrl = `${path}?filters=${filters}`;

  let lastErr;
  for (let attempt = 0; attempt <= retry; attempt++) {
    try {
      if (process.env.DEBUG === "1") {
        console.log(
          `[AFFILIATES] Fetch for TRDRID=${custTrdrId} (attempt ${
            attempt + 1
          }) → ${finalUrl}`
        );
      }
      const res = await api.get(finalUrl, { timeout: timeoutMs });
      if (res?.status >= 200 && res.status < 300) {
        const items = Array.isArray(res.data?.Items) ? res.data.Items : [];
        return items;
      }
      lastErr = new Error(`HTTP ${res?.status} ${res?.statusText || ""}`);
    } catch (e) {
      lastErr = e;
    }
    // brief backoff
    await new Promise((r) => setTimeout(r, 750));
  }
  throw lastErr || new Error("Unknown affiliates fetch error");
}

/**
 * Fetch affiliates for a *small set* of customers in parallel (limited concurrency).
 * @param {AxiosInstance} api
 * @param {string[]} customerTrdrIds - uppercase TRDRIDs
 * @param {{ timeoutMs?: number, retry?: number, concurrency?: number }} options
 * @returns {Promise<{ items: Array<Object>, stats: { totalCustomers:number, succeeded:number, failed:number } }>}
 */
async function fetchAffiliatesForCustomers(
  api,
  customerTrdrIds,
  { timeoutMs = 20000, retry = 1, concurrency = 3 } = {}
) {
  const ids = Array.from(
    new Set(
      (customerTrdrIds || [])
        .map((x) => String(x).toUpperCase())
        .filter(Boolean)
    )
  );
  const queue = ids.slice();
  const items = [];
  let succeeded = 0,
    failed = 0;

  async function worker() {
    while (queue.length) {
      const id = queue.shift();
      try {
        const got = await fetchAffiliatesByCustomer(api, id, {
          timeoutMs,
          retry,
        });
        items.push(...got);
        succeeded++;
      } catch (e) {
        failed++;
        console.warn(
          `[AFFILIATES] Fetch failed for TRDRID=${id}: ${e?.message || e}`
        );
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, ids.length) },
    () => worker()
  );
  await Promise.all(workers);

  return { items, stats: { totalCustomers: ids.length, succeeded, failed } };
}

module.exports = { fetchAffiliatesForCustomers };

// src/accounts/fetchAffiliates.js
const { buildRawFilter } = require("../utils/filters");

/**
 * Single Affiliates fetch using AFFILIATES_REVNUM >= minRev (inclusive).
 * - We keep it to one call as requested.
 * - Optional longer timeout & one retry to handle large result sets.
 *
 * @param {AxiosInstance} api - authenticated Galaxy axios instance
 * @param {number} minRev - minimum AFFILIATES_REVNUM (inclusive)
 * @param {{ timeoutMs?: number, retry?: number }} options
 * @returns {Promise<{ status:number, data:any }>}\
 */
async function fetchAffiliatesSince(
  api,
  minRev,
  { timeoutMs = 20000, retry = 1 } = {}
) {
  if (!(Number.isFinite(minRev) && minRev >= 0)) {
    return { status: 400, data: { message: "Invalid minRev" } };
  }

  const path = "/api/glx/views/Customer/custom/ZH_AFFILIATE";
  // Numeric minRev (no quotes) to avoid %22 in logs
  const filters = buildRawFilter(
    "AFFILIATES_REVNUM",
    Number(minRev),
    "GreaterOrEqual"
  );
  const finalUrl = `${path}?filters=${filters}`;

  let lastErr;
  for (let attempt = 0; attempt <= retry; attempt++) {
    try {
      if (process.env.DEBUG === "1") {
        console.log("[AFFILIATES] Request:", finalUrl);
      }
      const res = await api.get(finalUrl, { timeout: timeoutMs });
      return res;
    } catch (e) {
      lastErr = e;
      // brief backoff before retry
      await new Promise((r) => setTimeout(r, 750));
    }
  }
  throw lastErr || new Error("Unknown affiliates fetch error");
}

module.exports = { fetchAffiliatesSince };

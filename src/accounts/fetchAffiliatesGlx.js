// src/accounts/fetchAffiliatesGlx.js

/**
 * Fetch affiliates from Galaxy where AFFILIATES_REVNUM >= minRev.
 *
 * - Supports optional custom timeout and retry attempts (with fixed backoff).
 * - Always attempts the request at least once; on failure it retries up to `retry` times.
 * - Throws if all attempts fail.
 *
 * @param {AxiosInstance} api - Authenticated Galaxy API client.
 * @param {number} minRev - Minimum AFFILIATES_REVNUM (inclusive).
 * @param {{ timeoutMs?: number, retry?: number }} [options]
 *   - timeoutMs: Request timeout in milliseconds (default 20000).
 *   - retry: Number of retry attempts after the initial request (default 1).
 * @returns {Promise<AxiosResponse>} The successful Axios response.
 * @throws {Error} If all attempts fail or input is invalid.
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
      if (IS_DEBUG) {
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

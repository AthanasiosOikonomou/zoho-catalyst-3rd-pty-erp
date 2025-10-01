// src/utils/fetchAffiliates.js
const { buildRawFilter } = require("../utils/filters");

/**
 * Fetch affiliates from Galaxy with AFFILIATES_REVNUM >= minRev.
 * @param {AxiosInstance} api - already-authenticated api client
 * @param {number} minRev - minimum revision (inclusive)
 * @returns {Promise<{status:number, data?:any}>}
 */
async function fetchAffiliatesSince(api, minRev) {
  if (!(Number.isFinite(minRev) && minRev >= 0)) {
    return { status: 400, data: { message: "Invalid minRev" } };
  }

  const path = "/api/glx/views/Customer/custom/ZH_AFFILIATE";
  // raw filter grammar (no axios params)
  const filters = buildRawFilter("AFFILIATES_REVNUM", minRev, "GreaterOrEqual");
  const finalUrl = `${path}?filters=${filters}`;

  if (process.env.DEBUG === "1") {
    console.log("[AFFILIATES] Request:", finalUrl);
  }

  // Single call, let caller handle status
  return api.get(finalUrl);
}

module.exports = { fetchAffiliatesSince };

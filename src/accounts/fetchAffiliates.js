// src/accounts/fetchAffiliates.js
const { buildRawFilter } = require("../utils/filters");

/**
 * Fetch affiliates from Galaxy with AFFILIATES_REVNUM >= minRev (inclusive).
 * @param {AxiosInstance} api
 * @param {number} minRev
 * @returns {Promise<AxiosResponse>}
 */
async function fetchAffiliatesSince(api, minRev) {
  if (!(Number.isFinite(minRev) && minRev >= 0)) {
    return { status: 400, data: { message: "Invalid minRev" } };
  }
  const path = "/api/glx/views/Customer/custom/ZH_AFFILIATE";
  const filters = buildRawFilter("AFFILIATES_REVNUM", minRev, "GreaterOrEqual");
  const finalUrl = `${path}?filters=${filters}`;

  if (process.env.DEBUG === "1") {
    console.log("[AFFILIATES] Request:", finalUrl);
  }

  return api.get(finalUrl);
}

module.exports = { fetchAffiliatesSince };

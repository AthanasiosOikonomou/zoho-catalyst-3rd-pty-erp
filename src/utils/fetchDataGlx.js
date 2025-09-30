// src/customers.js

/**
 * Customers Module
 * ----------------
 * Provides functions to fetch customer data from the Galaxy API and
 * to compute the maximum THIRDPARTYREVNUM value for watermarking purposes.
 */

/**
 * Fetch data from Galaxy, optionally applying a THIRDPARTYREVNUM filter.
 * @param {AxiosInstance} api - The configured API client.
 * @param {string} path - The API endpoint path (for accounts or contacts).
 * @param {number} maxRev - The maximum THIRDPARTYREVNUM to filter by.
 * @returns {Promise<AxiosResponse>} The API response.
 */
async function fetchGalaxyData(api, path, maxRev) {
  let finalPath = path;

  if (maxRev > 0) {
    const filterString = `[{THIRDPARTYREVNUM:[${maxRev},Greater]}]`;
    finalPath += `?filters=${filterString}`;
    console.log(`[GLX] Fetching items with THIRDPARTYREVNUM > ${maxRev}`);
  } else {
    console.log("[GLX] Fetching ALL items (maxRev is 0 or less).");
  }

  return api.get(finalPath);
}

/**
 * Computes the maximum THIRDPARTYREVNUM from a list of customer items.
 * Useful for tracking the highest revision number (watermark).
 * @param {Array<Object>} items - Array of customer objects.
 * @returns {number|null} The maximum THIRDPARTYREVNUM, or null if not found.
 */
function maxThirdPartyRevNum(items) {
  let max = null;
  for (const it of items || []) {
    const v = Number(it?.THIRDPARTYREVNUM);
    if (!Number.isNaN(v)) {
      if (max === null || v > max) max = v;
    }
  }
  return max;
}

module.exports = {
  fetchGalaxyData,
  maxThirdPartyRevNum,
};

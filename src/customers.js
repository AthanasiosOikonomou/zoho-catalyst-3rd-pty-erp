// src/customers.js

/**
 * Customers Module
 * ----------------
 * Provides functions to fetch customer data from the Galaxy API and
 * to compute the maximum THIRDPARTYREVNUM value for watermarking purposes.
 */

/**
 * Fetch all customers from Galaxy, optionally applying a THIRDPARTYREVNUM filter.
 * Constructs the request path manually to match the API's expected format.
 * @param {AxiosInstance} api - The configured API client.
 * @param {number} maxRev - The maximum THIRDPARTYREVNUM to filter by.
 * @returns {Promise<AxiosResponse>} The API response.
 */
async function fetchCustomers(api, maxRev) {
  let path = "/api/glx/views/Customer/custom/zh_Customers_fin";

  // FIX: Revert to the exact string format that works in Postman's URL bar
  // The client will not use the 'params' object, forcing a manual, raw URL construction.
  if (maxRev > 0) {
    // The working structure: [{"THIRDPARTYREVNUM":[4946904,"Greater"]}]
    // We construct the entire query string manually, letting the API client interceptor do its minimal encoding work.
    const filterString = `[{THIRDPARTYREVNUM:[${maxRev},Greater]}]`;

    // Attach the filter to the path directly.
    // This is the simplest possible concatenation.
    path += `?filters=${filterString}`;

    console.log(`[GLX] Fetching items with THIRDPARTYREVNUM > ${maxRev}`);
  } else {
    console.log("[GLX] Fetching ALL items (maxRev is 0 or less).");
  }

  // Pass only the path. The API Client interceptor in apiClient.js will perform default encoding/handling.
  return api.get(path);
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
  fetchCustomers,
  maxThirdPartyRevNum,
};

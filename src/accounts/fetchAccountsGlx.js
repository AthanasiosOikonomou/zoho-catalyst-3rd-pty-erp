// src/accounts/fetchAccountsGlx.js

/**
 * Galaxy Data Utilities
 * ---------------------
 * Provides helper functions to interact with the Galaxy API:
 *  - Fetching data with optional revision-based filtering
 *  - Determining the highest THIRDPARTYREVNUM (watermark) from a dataset
 */

/**
 * Fetches data from Galaxy API, optionally filtered by THIRDPARTYREVNUM.
 * If a watermark (maxRev) is provided, only items with a higher revision
 * number will be returned.
 *
 * @param {AxiosInstance} api - Preconfigured Galaxy API client.
 * @param {string} path - API endpoint path (e.g., accounts or contacts).
 * @param {number} maxRev - Last processed THIRDPARTYREVNUM (0 = no filter).
 * @returns {Promise<AxiosResponse>} The raw API response.
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
 * Finds the highest THIRDPARTYREVNUM value in a dataset.
 * Non-numeric or missing values are ignored. Returns `null` if no valid
 * revision numbers are found.
 *
 * Typically used to track the latest watermark for incremental syncs.
 *
 * @param {Array<Object>} items - List of records containing THIRDPARTYREVNUM.
 * @returns {number|null} Highest THIRDPARTYREVNUM found, or null if none.
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

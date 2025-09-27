// src/customers.js

/**
 * Fetch all customers from Galaxy, optionally applying a THIRDPARTYREVNUM filter.
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
 * Compute the maximum THIRDPARTYREVNUM from a batch (still useful
 * if the field is present in the payload, so we can track watermarks).
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
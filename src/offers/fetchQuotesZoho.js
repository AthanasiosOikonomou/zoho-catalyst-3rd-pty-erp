// src/offers/fetchQuotesZoho.js

const { buildRawFilter } = require("../utils/filters");

/**
 * Fetch offers data from Galaxy, optionally applying a CommercialEntry_GXREVNUM filter.
 * @param {AxiosInstance} api - The configured API client.
 * @param {number} maxRev - The maximum CommercialEntry_GXREVNUM to filter by.
 * @returns {Promise<AxiosResponse>} The API response.
 */
async function fetchGalaxyOffers(api, maxRev) {
  const path = "/api/glx/views/salesentry/custom/zh_offers";
  let finalPath = path;

  if (maxRev > 0) {
    // CommercialEntry_GXREVNUM:[offerMaxRevNumber,Greater]
    const filterString = buildRawFilter(
      "CommercialEntry_GXREVNUM",
      maxRev,
      "Greater"
    ); // Filters field CommercialEntry_GXREVNUM > maxRev
    finalPath += `?filters=${filterString}`;
    console.log(
      `[GLX-OFFER] Fetching items with CommercialEntry_GXREVNUM > ${maxRev}`
    );
  } else {
    console.log("[GLX-OFFER] Fetching ALL items (maxRev is 0 or less).");
  }

  return api.get(finalPath);
}

/**
 * Fetch quote lines for a specific DOC_ID (the offer ID).
 * @param {AxiosInstance} api - The configured API client.
 * @param {string} docId - The DOC_ID of the offer.
 * @returns {Promise<AxiosResponse>} The API response.
 */
async function fetchQuoteLines(api, docId) {
  // Provided view URL
  const path =
    "/api/glx/advancedcustomviews/b6a2d6c9-e3bf-4d14-b000-269991c68dd5";
  // Filters: [{DOC_ID:[{offer ID},Equal]}]
  const filters = buildRawFilter("DOC_ID", docId, "Equal");
  const finalPath = `${path}?filters=${filters}`;

  if (process.env.DEBUG === "1") {
    console.log(
      `[GLX-LINES] Fetching lines for DOC_ID: ${docId.slice(0, 8)}...`
    );
  }

  // Set a longer timeout for line item fetches
  return api.get(finalPath, { timeout: 20000 });
}

module.exports = {
  fetchGalaxyOffers,
  fetchQuoteLines,
};

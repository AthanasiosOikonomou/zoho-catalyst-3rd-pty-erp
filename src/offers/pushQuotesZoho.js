// src/offers/pushQuotesZoho.js

const axios = require("axios");
const https = require("https");
const { getZohoAccessToken, getZohoBaseUrl } = require("../auth/zohoAuth");
const cfg = require("../config");

const keepAliveAgent = new https.Agent({ keepAlive: true });
const BATCH_SIZE = 100;

// -------- Reusable Utilities -------- //
const normStr = (v) => (v == null ? undefined : String(v).trim());
const normDigits = (v) => {
  if (v == null) return undefined;
  const s = String(v).replace(/\D+/g, "");
  return s.length ? s : undefined;
};
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const date = (v) => {
  const s = normStr(v);
  if (!s) return null;
  try {
    // Zoho expects YYYY-MM-DD or full date/time
    return new Date(s).toISOString().split("T")[0];
  } catch (_) {
    return null;
  }
};
// -------- Reusable Utilities -------- //

/**
 * Common Zoho API caller.
 *
 */
async function zohoApi(method, path, body, params) {
  const token = await getZohoAccessToken();
  const base = getZohoBaseUrl();
  const url = `${base}${path}`;
  return axios({
    method,
    url,
    data: body,
    params,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "Content-Type": "application/json",
    },
    timeout: cfg.timeoutMs,
    decompress: true,
    validateStatus: () => true,
    proxy: false,
    httpsAgent: keepAliveAgent,
  });
}

const TAX_RATE_MAP = {
  "0.0": "Tax Exempt", // 0% VAT
  "6.0": "VAT 6%",
  "13.0": "VAT 13%",
  "24.0": "VAT 24%", // Example: Standard VAT rate
};
const DEFAULT_TAX_RATE_NAME = "VAT 24%"; // Fallback if calculation fails or doesn't match a key

function getZohoTaxRateName(vatValue, netValue) {
  const vat = num(vatValue) || 0;
  const net = num(netValue) || 0;

  // Safety check: Skip if NETVALUE is zero or negative
  if (net <= 0) {
    if (vat > 0) return DEFAULT_TAX_RATE_NAME; // Fallback if VAT exists but NET is zero
    return TAX_RATE_MAP["0.0"];
  }

  // Calculate rate and round it to one decimal place for mapping
  const rate = Math.round((vat / net) * 1000) / 10;

  // Look for the rate in the map, prioritizing exact matches
  const name = TAX_RATE_MAP[rate.toFixed(1)] || TAX_RATE_MAP[rate.toFixed(0)];

  if (process.env.DEBUG === "1") {
    console.log(
      `[TAX CALC] VAT:${vat}, NET:${net}, Calc Rate:${rate.toFixed(
        1
      )}% -> Zoho Tax Name: ${name || DEFAULT_TAX_RATE_NAME}`
    );
  }

  return name || DEFAULT_TAX_RATE_NAME;
}

/**
 * Efficient watermark for CommercialEntry_GXREVNUM on Zoho Quotes.
 */
async function getMaxZohoQuoteRevNumber() {
  try {
    const res = await zohoApi("GET", "/crm/v2/Quotes", null, {
      fields: "Rev_Number", // Assumes the field API name is 'Rev_Number'
      sort_by: "Rev_Number",
      sort_order: "desc",
      per_page: 1,
      page: 1,
    });

    if (res.status !== 200) {
      console.log(
        `[ZOHO] Max Quote Rev Fetch failed (status ${res.status}). Response:`,
        res.data
      );
      return 0;
    }

    const records = Array.isArray(res.data?.data) ? res.data.data : [];
    if (records.length > 0) {
      const rev = Number(records[0].Rev_Number);
      return Number.isFinite(rev) ? rev : 0;
    }
    return 0;
  } catch (err) {
    console.error(
      "[ZOHO] Max Quote Rev Fetch API call error:",
      err.message || String(err)
    );
    return 0;
  }
}

/**
 * Searches Zoho Accounts by TIN (Account_AFM) to get the Zoho Account ID using COQL.
 * @param {string[]} tinList - Array of CUST_TIN values.
 * @returns {Promise<Map<string, string>>} Map of CUST_TIN -> Zoho Account ID.
 */
async function getAccountIdsByTin(tinList) {
  if (!tinList || tinList.length === 0) return new Map();

  const uniqueTins = Array.from(
    new Set(tinList.map(normDigits).filter((t) => t))
  );
  if (!uniqueTins.length) return new Map();

  console.log(
    `[ZOHO-ACCOUNT] Searching for ${uniqueTins.length} unique TINS...`
  );
  const tinToZohoId = new Map();

  // Process TINS in batches to respect COQL query length limits
  const QUERY_BATCH_SIZE = 250;

  for (let i = 0; i < uniqueTins.length; i += QUERY_BATCH_SIZE) {
    const batch = uniqueTins.slice(i, i + QUERY_BATCH_SIZE);
    const tinString = batch.map((t) => `'${t}'`).join(",");

    // Account_AFM is the API name for the TIN field on Accounts
    const query = `select id, Account_AFM from Accounts where Account_AFM in (${tinString})`;

    try {
      const res = await zohoApi("GET", "/crm/v8/coql", null, {
        select_query: query,
      });

      if (res.status !== 200 || !Array.isArray(res.data?.data)) {
        console.warn(
          `[ZOHO-ACCOUNT] COQL query batch failed (status ${res.status}).`
        );
        continue;
      }

      for (const record of res.data.data) {
        const tin = normDigits(record.Account_AFM);
        const id = record.id;
        if (tin && id) {
          tinToZohoId.set(tin, id);
        }
      }
    } catch (err) {
      console.error("[ZOHO-ACCOUNT] COQL API call error:", err.message);
    }
  }

  console.log(`[ZOHO-ACCOUNT] Found ${tinToZohoId.size} Zoho Account IDs.`);
  return tinToZohoId;
}

/**
 * Maps a single Galaxy Offer record to a Zoho Quote object (excluding the subform).
 */
function mapGalaxyToZohoQuote(gx, accountId) {
  const revNum = num(gx.CommercialEntry_GXREVNUM);

  // Mapping based on the provided fields:
  return {
    // Account_Name (Lookup): CUST_TIN (searched account)
    Account_Name: accountId ? { id: accountId } : undefined,
    // ERP_Offer_Number (Used for reference)
    ERP_Offer_Number: normStr(gx.TRADENUM),
    // ERP_ID_Offer (Used for de-duplication/external ID)
    ERP_ID_Offer: normStr(gx.ID),
    // Service_Store
    Service_Store: normStr(gx.CMPSDESCRIPTION),
    // Quote_Stage
    Quote_Stage: normStr(gx.OFFER_STATUS),
    // Products_Quantity
    Products_Quantity: num(gx.CENLAQTY),
    // ERP_Total_Amount (Calculated field)
    ERP_Total_Amount: num(gx.TotalValue),
    // Valid_Till
    Valid_Till: date(gx.ETA),
    // Offer_Valid
    Offer_Valid: normStr(gx.OFFERS_VALID),
    // Quote_Date
    Quote_Date: date(gx.OFFICIALDATE),
    // Payment_Terms
    Payment_Terms: normStr(gx.PayTerms),
    // Rev_Number (For Watermark)
    Rev_Number: revNum,
  };
}

/**
 * Maps a single Galaxy Offer Line record to a Zoho Product object (for upsert).
 * MODIFIED: Adds a Tax field using the calculated rate name.
 */
function mapLineToZohoProduct(line) {
  const productCode = normStr(line.ITEMDESCRIPTION);
  const taxRateName = getZohoTaxRateName(line.VATVALUE, line.NETVALUE);

  return {
    Product_Code: productCode,
    Product_Name: productCode,
    Unit_Price: num(line.PRICE),
    // Tax (Assuming 'Tax' is the API name for the Tax Rate field on the Product)
    Tax: taxRateName,
  };
}

/**
 * Maps a single Galaxy Offer Line record to a Zoho Quote Line Item object.
 * MODIFIED: Adds a Tax field to the line item using the calculated rate name.
 */
function mapGalaxyToZohoQuoteLine(line, zohoProductId) {
  // Product Name (Lookup) requires a Zoho Product ID
  const Product_Name_Lookup = zohoProductId ? { id: zohoProductId } : undefined;

  // Calculate the tax rate name for the subform field
  const taxRateName = getZohoTaxRateName(line.VATVALUE, line.NETVALUE);

  // Mapping for Quoted Items Subform
  return {
    Product_Name: Product_Name_Lookup,
    Description: normStr(line.ITEMDESCRIPTION), // ITEMDESCRIPTION is Product Name/Description
    LEAD_TIME: normStr(line.LEAD_TIME), // Assuming LEAD_TIME is the Description field
    Quantity: num(line.QTY),
    List_Price: num(line.PRICE),
    Amount: num(line.GROSSVALUE),
    Discount: num(line.DISCVALUE),
    Net_Total: num(line.NETVALUE),
    TAX: num(line.VATVALUE),

    // NEW: Assign the calculated Tax Rate Name to the Tax Rate picklist field on the subform
    Tax: taxRateName, // Assuming 'Tax' is the API name for the Tax Rate Picklist/Lookup on the subform
  };
}

// --- ensureProducts (MODIFIED for Product Tax Field) ---
// The logic for ensureProducts remains structurally the same, but it now calls the
// MODIFIED mapLineToZohoProduct which includes the Tax Rate name.

async function ensureProducts(allQuoteLines) {
  const productCodeToZohoId = new Map();

  // 1. Collect unique products to sync
  const uniqueProducts = new Map();
  for (const line of allQuoteLines) {
    const productCode = normStr(line.ITEMDESCRIPTION);
    if (productCode) {
      // Note: We use the *current* line's tax calculation for the product upsert
      // If the same product code appears with different tax rates, the last one processed wins.
      uniqueProducts.set(productCode, mapLineToZohoProduct(line));
    }
  }
  const productsToUpsert = Array.from(uniqueProducts.values());

  // ... (rest of batching/upsert logic remains the same, using Product_Code for duplicate check) ...
  console.log(
    `[ZOHO-PRODUCT] Need to sync ${productsToUpsert.length} unique products.`
  );
  if (!productsToUpsert.length) return productCodeToZohoId;

  let success = 0;
  const groups = Array.from(
    { length: Math.ceil(productsToUpsert.length / BATCH_SIZE) },
    (_, i) =>
      productsToUpsert.slice(i * BATCH_SIZE, i * BATCH_SIZE + BATCH_SIZE)
  );

  // 2. Upsert Products
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    const res = await zohoApi(
      "POST",
      "/crm/v8/Products/upsert",
      { data: group },
      { duplicate_check_fields: "Product_Code" }
    );

    if (res.status === 200 && Array.isArray(res.data?.data)) {
      for (let i = 0; i < res.data.data.length; i++) {
        const rowRes = res.data.data[i];
        const sent = group[i];
        if (rowRes.status === "success") {
          success += 1;
          const zid = rowRes.details?.id;
          if (zid && sent?.Product_Code)
            productCodeToZohoId.set(sent.Product_Code, zid);
        }
      }
    } else {
      console.warn(
        `[ZOHO-PRODUCT] Upsert batch ${gi + 1}/${groups.length} HTTP ${
          res.status
        }. Body:`,
        res.data
      );
    }
  }

  console.log(
    `[ZOHO-PRODUCT] Product sync complete. Success: ${success}. ID map size: ${productCodeToZohoId.size}.`
  );
  return productCodeToZohoId;
}

/**
 * Upsert Quotes with associated lines.
 */
async function upsertQuotes(
  galaxyOffers,
  quoteLinesByOfferId,
  accountIdByTin,
  productIdByCode
) {
  const mappedQuotes = [];
  let dropped = 0;

  for (const gx of galaxyOffers) {
    const tin = normDigits(gx.CUST_TIN);
    const accountId = accountIdByTin.get(tin);

    // Skip quotes without a linked, existing Zoho Account
    if (!accountId) {
      dropped++;
      continue;
    }

    const baseQuote = mapGalaxyToZohoQuote(gx, accountId);

    // 1. Map Quote Lines
    const lines = quoteLinesByOfferId.get(gx.ID) || [];
    const mappedLines = lines
      .map((line) => {
        const productCode = normStr(line.ITEMDESCRIPTION);
        const zohoProductId = productIdByCode.get(productCode);
        // Only map the line if the product was successfully synced
        return mapGalaxyToZohoQuoteLine(line, zohoProductId);
      })
      .filter((line) => line.Product_Name);

    // 2. Attach the lines to the quote object
    const quoteWithLines = {
      ...baseQuote,
      Quoted_Items: mappedLines, // Assuming 'Quoted_Items' is the subform API name
    };

    mappedQuotes.push(quoteWithLines);
  }

  console.log(
    `[ZOHO-QUOTE] Mapped ${mappedQuotes.length} item(s). Dropped: ${dropped}.`
  );

  if (!mappedQuotes.length) {
    return { success: 0, failed: 0, details: [] };
  }

  let success = 0,
    failed = 0;
  const groups = Array.from(
    { length: Math.ceil(mappedQuotes.length / BATCH_SIZE) },
    (_, i) => mappedQuotes.slice(i * BATCH_SIZE, i * BATCH_SIZE + BATCH_SIZE)
  );

  // 3. Upsert Batches
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    // Use 'ERP_ID_Offer' for duplicate check (your external ID field)
    const res = await zohoApi(
      "POST",
      "/crm/v8/Quotes/upsert",
      { data: group },
      { duplicate_check_fields: "ERP_ID_Offer" }
    );

    if (res.status === 200 && Array.isArray(res.data?.data)) {
      success += res.data.data.filter((r) => r.status === "success").length;
      failed += res.data.data.filter((r) => r.status === "error").length;
    } else {
      failed += group.length;
      console.warn(
        `[ZOHO-QUOTE] Upsert batch ${gi + 1}/${groups.length} HTTP ${
          res.status
        }.`
      );
    }
  }

  return { success, failed };
}

module.exports = {
  getMaxZohoQuoteRevNumber,
  getAccountIdsByTin,
  ensureProducts,
  upsertQuotes,
};

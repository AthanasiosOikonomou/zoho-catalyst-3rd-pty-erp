// src/zohoAuth.js
const axios = require("axios");
const cfg = require("./config");

// Map Zoho data centers → base domains
function zohoDomains(dcRaw) {
  const dc = String(dcRaw || "").toLowerCase();
  const map = {
    eu: {
      accounts: "https://accounts.zoho.eu",
      api: "https://www.zohoapis.eu",
    }
  };
  return map[dc];
}

function getZohoBaseUrl() {
  const dom = zohoDomains(cfg.zoho.dc);
  if (!dom || !dom.api) {
    throw new Error(
      `Invalid ZOHO_DC "${cfg.zoho.dc}". Use one of: us, eu, in, au, jp, ca.`
    );
  }
  return dom.api;
}

let tokenCache = { accessToken: null, expiresAt: 0 };

async function getZohoAccessToken() {
  const now = Date.now();
  // Refresh 10 seconds early
  if (tokenCache.accessToken && now < tokenCache.expiresAt - 10_000) {
    return tokenCache.accessToken;
  }

  const dom = zohoDomains(cfg.zoho.dc);
  if (!dom || !dom.accounts) {
    throw new Error(
      `Invalid ZOHO_DC "${cfg.zoho.dc}" (no accounts URL). Use: us, eu, in, au, jp, ca.`
    );
  }

  // Basic validation so you get a friendly error early
  if (!cfg.zoho.clientId || !cfg.zoho.clientSecret || !cfg.zoho.refreshToken) {
    throw new Error(
      "Missing Zoho OAuth env: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN"
    );
  }

  const url = `${dom.accounts}/oauth/v2/token`;
  const params = {
    grant_type: "refresh_token",
    refresh_token: cfg.zoho.refreshToken,
    client_id: cfg.zoho.clientId,
    client_secret: cfg.zoho.clientSecret,
  };

  // NOTE: Removed keepAlive agents for quick job termination
  const res = await axios.post(url, null, {
    params,
    timeout: cfg.timeoutMs,
    validateStatus: () => true,
    proxy: false,
  });

  if (res.status !== 200 || !res.data?.access_token) {
    throw new Error(
      `Zoho OAuth failed: HTTP ${res.status} ${res.statusText} ${JSON.stringify(
        res.data
      )}`
    );
  }

  tokenCache.accessToken = res.data.access_token;
  // Expires in (seconds) * 1000 (ms)
  tokenCache.expiresAt = now + Number(res.data.expires_in || 3600) * 1000; 
  return tokenCache.accessToken;
}

module.exports = { getZohoAccessToken, getZohoBaseUrl };
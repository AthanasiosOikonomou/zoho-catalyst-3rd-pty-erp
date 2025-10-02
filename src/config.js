// src/config.js

/**
 * Configuration Module
 * --------------------
 * Loads environment variables and validates essential config.
 * Features:
 *  - Base URL validation
 *  - Credentials check
 *  - Session file and Zoho config
 */

function cleanUrl(s) {
  return String(s || "")
    .trim()
    .replace(/^"+|"+$/g, "")
    .replace(/^'+|'+$/g, "");
}

const cfg = {
  baseURL: cleanUrl(process.env.BASE_URL),
  username: process.env.AUTH_USERNAME,
  password: process.env.AUTH_PASSWORD,
  ssPid: process.env.SS_PID_COOKIE || null,
  cronExpr: process.env.CRON || "* * * * *",
  timeoutMs: Number(process.env.TIMEOUT_MS || 20000),
  sessionFile: process.env.SESSION_FILE || "./.session.json",
  IS_DEBUG: process.env.DEBUG === "1",
  zoho: {
    clientId: process.env.ZOHO_CLIENT_ID,
    clientSecret: process.env.ZOHO_CLIENT_SECRET,
    refreshToken: process.env.ZOHO_REFRESH_TOKEN,
    dc: process.env.ZOHO_DC || "eu",
  },
};

// Validate mandatory config
if (!cfg.baseURL) {
  throw new Error("Missing BASE_URL");
}
try {
  new URL(cfg.baseURL);
} catch (e) {
  throw new Error(`Invalid BASE_URL value: "${cfg.baseURL}" (${e.message})`);
}
if (!cfg.username || !cfg.password) {
  throw new Error("Missing AUTH_USERNAME and/or AUTH_PASSWORD in .env");
}

module.exports = cfg;

/**
 * Configuration Module
 * --------------------
 * Loads and validates environment variables for application settings,
 * including API credentials, session management, scheduling, and Zoho integration.
 */

/**
 * Cleans up a string value by removing leading/trailing quotes and whitespace.
 * Useful for sanitizing .env values on Windows.
 * @param {string} s - The string to clean.
 * @returns {string} The cleaned string.
 */
function cleanUrl(s) {
  return String(s || "")
    .trim()
    .replace(/^"+|"+$/g, "") // strip leading/trailing "
    .replace(/^'+|'+$/g, ""); // strip leading/trailing '
}

/**
 * Application configuration object.
 * Populated from environment variables and includes validation for required fields.
 */
const cfg = {
  baseURL: cleanUrl(process.env.BASE_URL),
  username: process.env.AUTH_USERNAME,
  password: process.env.AUTH_PASSWORD,
  ssPid: process.env.SS_PID_COOKIE || null,
  cronExpr: process.env.CRON || "* * * * *", // dev default: every minute
  timeoutMs: Number(process.env.TIMEOUT_MS || 15000),
  sessionFile: process.env.SESSION_FILE || "./.session.json",
  zoho: {
    clientId: process.env.ZOHO_CLIENT_ID,
    clientSecret: process.env.ZOHO_CLIENT_SECRET,
    refreshToken: process.env.ZOHO_REFRESH_TOKEN,
    dc: process.env.ZOHO_DC || "eu",
  },
};

// Validate required configuration values early and provide helpful error messages.
if (!cfg.baseURL) {
  throw new Error(
    "Missing BASE_URL in .env (e.g., BASE_URL=http://192.168.0.135 — no quotes)"
  );
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

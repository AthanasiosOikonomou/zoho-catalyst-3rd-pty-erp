/**
 * Configuration Module
 * --------------------
 * Loads and validates environment variables for application settings,
 * including API credentials, session management, scheduling, and Zoho integration.
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
  cronExpr: process.env.CRON || "* * * * *", // dev default: every minute
  timeoutMs: Number(process.env.TIMEOUT_MS || 8000), // tighter default for faster fail
  sessionFile: process.env.SESSION_FILE || "./.session.json",
  zoho: {
    clientId: process.env.ZOHO_CLIENT_ID,
    clientSecret: process.env.ZOHO_CLIENT_SECRET,
    refreshToken: process.env.ZOHO_REFRESH_TOKEN,
    dc: process.env.ZOHO_DC || "eu",
  },
};

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

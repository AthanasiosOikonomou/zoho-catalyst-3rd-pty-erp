// src/auth/auth.js

/**
 * Authentication Module
 * ---------------------
 * Handles authentication against Galaxy API.
 * Features:
 *  - Session management via cookies
 *  - Extracts ss-pid for session continuity
 *  - Throws errors for failed authentication
 */

const axios = require("axios");
const cfg = require("../config");

/**
 * Extract value from Set-Cookie headers
 * @param {string[]|string} setCookieHeaders
 * @param {string} name
 * @returns string|null
 */
function extractCookieValue(setCookieHeaders, name) {
  if (!setCookieHeaders) return null;
  const headers = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : [setCookieHeaders];
  for (const line of headers) {
    const first = String(line || "").split(";")[0];
    const [k, v] = first.split("=");
    if (k && v && k.trim().toLowerCase() === name.toLowerCase()) {
      return v.trim();
    }
  }
  return null;
}

/**
 * Build authentication URL
 */
function buildAuthUrl() {
  try {
    return new URL("/auth", cfg.baseURL).toString();
  } catch (e) {
    console.error("[AUTH] Invalid BASE_URL when building /auth:", cfg.baseURL);
    throw e;
  }
}

/**
 * Authenticate to Galaxy API
 * @param {string|null} currentSsPid
 * @returns {Promise<{sessionId:string, ssPid:string|null}>}
 */
async function authenticate(currentSsPid = null) {
  const url = buildAuthUrl();
  const base = new URL(cfg.baseURL);

  const res = await axios.get(url, {
    params: { username: cfg.username, password: cfg.password },
    headers: {
      Accept: "application/json",
      ...(currentSsPid ? { Cookie: `ss-pid=${currentSsPid}` } : {}),
      Host: base.hostname,
    },
    timeout: cfg.timeoutMs,
    validateStatus: () => true,
    proxy: false,
  });

  const maybeNewPid = extractCookieValue(res.headers?.["set-cookie"], "ss-pid");

  if (res.status >= 200 && res.status < 300) {
    const sessionId = res.data?.SessionId;
    if (!sessionId)
      throw new Error("Auth succeeded but no SessionId in payload.");
    return { sessionId, ssPid: maybeNewPid || currentSsPid || null };
  }

  const message =
    res.data?.ResponseStatus?.Message || `HTTP ${res.status} ${res.statusText}`;
  const err = new Error(`Auth failed: ${message}`);
  err.status = res.status;
  err.ssPid = maybeNewPid || currentSsPid || null;
  throw err;
}

module.exports = { authenticate };

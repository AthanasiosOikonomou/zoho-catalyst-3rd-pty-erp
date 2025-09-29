/**
 * Authentication Module
 * ---------------------
 * Handles authentication against the backend API, including session management
 * via cookies and error handling for failed authentication attempts.
 */

const axios = require("axios");
const cfg = require("./config");

/**
 * Extracts the value of a specific cookie from the 'Set-Cookie' headers.
 * @param {string[]|string} setCookieHeaders - The 'Set-Cookie' header(s) from the response.
 * @param {string} name - The name of the cookie to extract.
 * @returns {string|null} The cookie value, or null if not found.
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
 * Constructs the authentication endpoint URL using the base URL from config.
 * @returns {string} The full authentication URL.
 * @throws Will throw if the base URL is invalid.
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
 * Authenticates with the backend API using credentials from config.
 * Optionally uses an existing ss-pid cookie for session continuity.
 * @param {string|null} currentSsPid - Existing ss-pid cookie value, if available.
 * @returns {Promise<{sessionId: string, ssPid: string|null}>} Auth result with session ID and ss-pid.
 * @throws Will throw an error if authentication fails.
 */
async function authenticate(currentSsPid = null) {
  const url = buildAuthUrl();
  const base = new URL(cfg.baseURL);
  // NOTE: Removed keepAlive agents for quick job termination
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

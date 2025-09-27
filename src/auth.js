// src/auth.js
const axios = require("axios");
const cfg = require("./config");

function extractCookieValue(setCookieHeaders, name) {
  if (!setCookieHeaders) return null;
  const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const line of headers) {
    const first = String(line || "").split(";")[0];
    const [k, v] = first.split("=");
    if (k && v && k.trim().toLowerCase() === name.toLowerCase()) {
      return v.trim();
    }
  }
  return null;
}

function buildAuthUrl() {
  try {
    return new URL("/auth", cfg.baseURL).toString();
  } catch (e) {
    console.error("[AUTH] Invalid BASE_URL when building /auth:", cfg.baseURL);
    throw e;
  }
}

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
    if (!sessionId) throw new Error("Auth succeeded but no SessionId in payload.");
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
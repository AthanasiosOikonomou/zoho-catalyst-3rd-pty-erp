// src/api/apiClient.js

/**
 * API Client Factory Module
 * -------------------------
 * Creates a configured Axios HTTP client for Galaxy API.
 * Features:
 *  - Keep-alive HTTPS agent
 *  - Automatic session cookie injection (ss-id)
 *  - Debug logging of final request URL and attached cookies
 */

const axios = require("axios");
const https = require("https");
const cfg = require("../config");

// Keep-alive agent reused across requests
const keepAliveAgent = new https.Agent({ keepAlive: true });

/**
 * Factory to create API client
 * @param {Function} getSessionId - function returning current sessionId
 * @returns Axios instance
 */
function createApiClient(getSessionId) {
  let base;
  try {
    base = new URL(cfg.baseURL);
  } catch (e) {
    console.error("[API] Invalid cfg.baseURL:", cfg.baseURL);
    throw e;
  }

  const api = axios.create({
    baseURL: cfg.baseURL,
    timeout: cfg.timeoutMs,
    validateStatus: () => true,
    decompress: true,
    proxy: false,
    httpsAgent: keepAliveAgent,
  });

  // Attach interceptors for logging and session management
  api.interceptors.request.use((req) => {
    req.headers = req.headers || {};
    req.headers["Accept"] = "application/json";
    req.headers["Host"] = base.hostname;

    const isAuth = String(req.url || "").includes("/auth");
    if (!isAuth) {
      const sid = getSessionId?.();
      if (sid) {
        req.headers["Cookie"] = `ss-id=${sid}`;
        if (processIS_DEBUG) {
          console.log("[REQ] Attaching ss-id cookie:", sid.slice(0, 6) + "...");
        }
      }
    }

    // Debug: log final request URL
    if (IS_DEBUG) {
      try {
        const u = new URL(req.url || "", api.defaults.baseURL);
        if (req.params && typeof req.params === "object") {
          for (const [k, v] of Object.entries(req.params)) {
            if (v !== undefined && v !== null)
              u.searchParams.append(k, String(v));
          }
        }
        console.log("[FINAL REQ URL]", u.toString());
      } catch (e) {
        console.log("[REQ URL] (failed to render)", e.message);
      }
    }
    return req;
  });

  return api;
}

module.exports = { createApiClient };

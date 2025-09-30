/**
 * API Client Factory Module
 * -------------------------
 * Provides a function to create a configured Axios HTTP client for communicating
 * with the backend API. Handles session authentication via cookies and logs requests
 * for debugging purposes.
 */

const axios = require("axios");
const cfg = require("../config");

/**
 * Creates an Axios API client instance with custom configuration and interceptors.
 * @param {Function} getSessionId - Function to retrieve the current session ID for authentication.
 * @returns {AxiosInstance} Configured Axios client.
 */
function createApiClient(getSessionId) {
  let base;
  try {
    // Parse and validate the base URL from configuration.
    base = new URL(cfg.baseURL);
  } catch (e) {
    console.error("[API] Invalid cfg.baseURL:", cfg.baseURL);
    throw e;
  }

  // Create Axios instance with custom settings.
  const api = axios.create({
    baseURL: cfg.baseURL,
    timeout: cfg.timeoutMs,
    validateStatus: () => true, // Accept all HTTP status codes.
    decompress: true,
    proxy: false,
  });

  // Request interceptor to attach headers and session cookie.
  api.interceptors.request.use((req) => {
    req.headers = req.headers || {};
    req.headers["Accept"] = "application/json";
    req.headers["Host"] = base.hostname;

    // Skip attaching session cookie for authentication endpoints.
    const isAuth = String(req.url || "").includes("/auth");
    if (!isAuth) {
      const sid = getSessionId?.();
      if (sid) {
        req.headers["Cookie"] = `ss-id=${sid}`;
        if (process.env.DEBUG === "1") {
          console.log("[REQ] Attaching ss-id cookie:", sid.slice(0, 6) + "...");
        }
      }
    }

    // Debug: Log the final constructed request URL.
    if (process.env.DEBUG === "1") {
      try {
        const u = new URL(req.url || "", api.defaults.baseURL);
        // Append query parameters if present.
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

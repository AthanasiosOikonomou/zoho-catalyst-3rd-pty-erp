// src/apiClient.js
const axios = require("axios");
const cfg = require("./config");

function createApiClient(getSessionId) {
  let base;
  try {
    base = new URL(cfg.baseURL);
  } catch (e) {
    console.error("[API] Invalid cfg.baseURL:", cfg.baseURL);
    throw e;
  }

  // NOTE: Removed keepAlive agents for quick job termination
  const api = axios.create({
    baseURL: cfg.baseURL,
    timeout: cfg.timeoutMs,
    validateStatus: () => true,
    decompress: true,
    proxy: false,
  });

  api.interceptors.request.use((req) => {
    req.headers = req.headers || {};
    req.headers["Accept"] = "application/json";
    req.headers["Host"] = base.hostname;

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

   if (process.env.DEBUG === "1") {
      try {
        const u = new URL(req.url || "", api.defaults.baseURL);
        
        // --- FIX: LOG THE FINAL CONSTRUCTED URL ---
        if (req.params && typeof req.params === "object") {
          for (const [k, v] of Object.entries(req.params)) {
            if (v !== undefined && v !== null) u.searchParams.append(k, String(v));
          }
        }
        console.log("[FINAL REQ URL]", u.toString()); // THIS WILL LOG THE URL
      } catch (e) {
        console.log("[REQ URL] (failed to render)", e.message);
      }
    }
    return req;
  });

  return api;
}

module.exports = { createApiClient };
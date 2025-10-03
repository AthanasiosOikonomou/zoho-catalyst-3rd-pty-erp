// src/utils/sessionStore.js

/**
 * SessionStore Module
 * -------------------
 * Provides persistent storage for sessionId and ssPid using a JSON file.
 * Features:
 *  - Load sessions on startup
 *  - Save sessions on update
 *  - Clear sessions
 */

const fs = require("fs");

/**
 * SessionStore class
 */
class SessionStore {
  /**
   * Constructor
   * @param {string} path - Path to session JSON file
   */
  constructor(path) {
    this.path = path;
    this.data = { sessionId: null, ssPid: null };
    this._load();
  }

  /**
   * Load session data from file
   * @private
   */

  _load() {
    try {
      const raw = fs.readFileSync(this.path, "utf-8");
      const parsed = JSON.parse(raw);
      this.data.sessionId = parsed?.sessionId || null;
      this.data.ssPid = parsed?.ssPid || null;
    } catch (err) {
      if (err.code !== "ENOENT") {
        // Only ignore "File Not Found"
        console.warn(
          `[SessionStore] Could not load session file: ${err.message}`
        );
      }
    }
  }

  /** @returns {string|null} sessionId */
  getSessionId() {
    return this.data.sessionId;
  }

  /** @returns {string|null} ssPid */
  getSsPid() {
    return this.data.ssPid;
  }

  /**
   * Set both sessionId and ssPid and persist
   * @param {{sessionId:string, ssPid:string}} param0
   */
  setAll({ sessionId = this.data.sessionId, ssPid = this.data.ssPid } = {}) {
    this.data.sessionId = sessionId;
    this.data.ssPid = ssPid;
    try {
      fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2), "utf-8");
    } catch (err) {
      console.warn("Could not persist session file:", err.message);
    }
  }

  /** Clear session data */
  clear() {
    this.setAll({ sessionId: null, ssPid: null });
  }
}

module.exports = SessionStore;

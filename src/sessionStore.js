/**
 * SessionStore Module
 * -------------------
 * Provides a simple persistent store for session identifiers (sessionId, ssPid)
 * using a local JSON file. Handles loading, saving, and clearing session data.
 */

const fs = require("fs");

/**
 * SessionStore class for managing session data persistence.
 */
class SessionStore {
  /**
   * Constructs a SessionStore instance and loads session data from file.
   * @param {string} path - Path to the session file.
   */
  constructor(path) {
    this.path = path;
    this.data = { sessionId: null, ssPid: null };
    this._load();
  }

  /**
   * Loads session data from the file, if available.
   * Silently ignores missing or invalid files.
   * @private
   */
  _load() {
    try {
      const raw = fs.readFileSync(this.path, "utf-8");
      const parsed = JSON.parse(raw);
      this.data.sessionId = parsed?.sessionId || null;
      this.data.ssPid = parsed?.ssPid || null;
    } catch (_) {
      // ignore missing file
    }
  }

  /**
   * Gets the current sessionId.
   * @returns {string|null}
   */
  getSessionId() {
    return this.data.sessionId;
  }

  /**
   * Gets the current ssPid.
   * @returns {string|null}
   */
  getSsPid() {
    return this.data.ssPid;
  }

  /**
   * Sets and persists both sessionId and ssPid.
   * @param {Object} param0 - Object containing sessionId and ssPid.
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

  /**
   * Clears both sessionId and ssPid, and persists the change.
   */
  clear() {
    this.setAll({ sessionId: null, ssPid: null });
  }
}

module.exports = SessionStore;

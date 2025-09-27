const fs = require("fs");

class SessionStore {
  constructor(path) {
    this.path = path;
    this.data = { sessionId: null, ssPid: null };
    this._load();
  }

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

  getSessionId() {
    return this.data.sessionId;
  }

  getSsPid() {
    return this.data.ssPid;
  }

  setAll({ sessionId = this.data.sessionId, ssPid = this.data.ssPid } = {}) {
    this.data.sessionId = sessionId;
    this.data.ssPid = ssPid;
    try {
      fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2), "utf-8");
    } catch (err) {
      console.warn("Could not persist session file:", err.message);
    }
  }

  clear() {
    this.setAll({ sessionId: null, ssPid: null });
  }
}

module.exports = SessionStore;
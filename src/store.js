// Tiny JSON-file store. Good for one organization up to a few hundred.
// Writes are atomic (temp file + rename) and serialized.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    fs.mkdirSync(dir, { recursive: true });
    this.data = { orgs: {} };
    if (fs.existsSync(this.file)) {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!this.data.orgs) this.data.orgs = {};
    }
    this._chain = Promise.resolve();
  }

  save() {
    const snapshot = JSON.stringify(this.data, null, 2);
    this._chain = this._chain.then(() => new Promise((resolve, reject) => {
      const tmp = this.file + '.' + process.pid + '.tmp';
      fs.writeFile(tmp, snapshot, err => {
        if (err) return reject(err);
        fs.rename(tmp, this.file, e => (e ? reject(e) : resolve()));
      });
    }));
    return this._chain;
  }

  newToken() {
    return crypto.randomBytes(18).toString('base64url');
  }

  listOrgs() { return Object.values(this.data.orgs); }
  getOrg(token) { return this.data.orgs[token] || null; }

  createOrg(profile) {
    const token = this.newToken();
    const now = new Date().toISOString();
    const org = { token, createdAt: now, updatedAt: now, profile, grants: {}, manual: [], lastRun: null, runs: [] };
    this.data.orgs[token] = org;
    return org;
  }

  deleteOrg(token) { delete this.data.orgs[token]; }
}

module.exports = { Store };

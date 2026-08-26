import fs from 'node:fs';
import path from 'node:path';
import { MEDIA_DIR } from '../config.js';
import { BaseStore } from './base-store.js';

/**
 * Local-filesystem backing — the default for `npm start`, the CLI poller and
 * every test.
 *
 * Behaviour is byte-for-byte what the old single `Store` class did, so
 * `mediaDir` and `mediaPathFor()` are still exposed: `hf.js` and `backup.js`
 * walk the media tree with `fs` directly and only ever run on a Node host with
 * a real disk. Everything else goes through the async media interface, which
 * both backends implement.
 */
export class FsStore extends BaseStore {
  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
    this.mediaDir = path.join(dataDir, MEDIA_DIR);
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.mkdirSync(this.mediaDir, { recursive: true });
  }

  _file(name) {
    return path.join(this.dataDir, name);
  }

  readJson(name, fallback) {
    try {
      return JSON.parse(fs.readFileSync(this._file(name), 'utf8'));
    } catch {
      return fallback;
    }
  }

  writeJson(name, value) {
    // tmp + rename: a crash mid-write must not leave a truncated document,
    // because readJson would silently fall back past it and lose all state.
    const tmp = this._file(name) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, this._file(name));
  }

  /* ---- media ---- */

  mediaPathFor(username, fileName) {
    const dir = path.join(this.mediaDir, username);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, fileName);
  }

  async hasMedia(username, name) {
    return fs.existsSync(path.join(this.mediaDir, username, name));
  }

  async putMedia(username, name, bytes) {
    fs.writeFileSync(this.mediaPathFor(username, name), bytes);
    return name;
  }

  async getMedia(username, name) {
    try {
      return fs.readFileSync(path.join(this.mediaDir, username, name));
    } catch {
      return null;
    }
  }

  async listMedia(username = null) {
    const users = username ? [username] : this._mediaUsers();
    const out = [];
    for (const user of users) {
      const dir = path.join(this.mediaDir, user);
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        let st;
        try {
          st = fs.statSync(path.join(dir, name));
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        out.push({ username: user, name, bytes: st.size, mtimeMs: st.mtimeMs });
      }
    }
    return out;
  }

  _mediaUsers() {
    try {
      return fs
        .readdirSync(this.mediaDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  async deleteMedia(username, name) {
    try {
      fs.unlinkSync(path.join(this.mediaDir, username, name));
      return true;
    } catch {
      return false;
    }
  }

  async renameMedia(oldUsername, newUsername) {
    const oldDir = path.join(this.mediaDir, oldUsername);
    const newDir = path.join(this.mediaDir, newUsername);
    if (!fs.existsSync(oldDir) || fs.existsSync(newDir)) return false;
    try {
      fs.renameSync(oldDir, newDir);
      return true;
    } catch {
      return false;
    }
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { ZipArchive } from 'archiver';

export function buildBackupArchive(store, { username = null } = {}) {
  const archive = new ZipArchive({ zlib: { level: 6 } });

  if (username) {
    if (store.mediaDir) {
      const dir = path.join(store.mediaDir, username);
      if (fs.existsSync(dir)) archive.directory(dir, `${username}/media`);
    }
    const h = store.getHistory();
    const cfg = store.getConfig();
    archive.append(JSON.stringify(h.profiles[username] || [], null, 2), { name: `${username}/history.json` });
    const entry = (cfg.profiles || []).find((p) => p.username === username) || { username };
    archive.append(JSON.stringify(entry, null, 2), { name: `${username}/profile.json` });
  } else {
    if (store.dataDir) {
      archive.directory(store.dataDir, false);
    } else {
      const h = store.getHistory();
      const cfg = store.getConfig();
      archive.append(JSON.stringify(h, null, 2), { name: 'history.json' });
      archive.append(JSON.stringify(cfg, null, 2), { name: 'config.json' });
    }
  }

  archive.finalize();
  return archive;
}

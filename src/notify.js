import { poll } from './poller.js';
import { syncToHF, hfEnabled } from './hf.js';
import { sendTelegram, buildChangeAlert, buildDigest, shouldSendDigest, telegramConfigured } from './telegram.js';

export async function pollAndNotify(store, config, { force = false } = {}) {
  const result = await poll(store, config, { force });

  const hf = await syncHFAfterPoll(store, config);

  const alerts = [];
  if (telegramConfigured(config) && store.getConfig().alertsEnabled !== false) {
    for (const r of result.results || []) {
      if (!r.ok || !r.due) continue;
      if ((r.changeCount || 0) > 0 || (r.newStories || 0) > 0) {
        await sendTelegram(config, buildChangeAlert(r.username, r));
        alerts.push(r.username);
      }
    }
  }

  await maybeSendDigest(store, config);

  return { ...result, hf, alerts };
}

async function syncHFAfterPoll(store, config) {
  if (!hfEnabled(config)) return null;
  try {
    const r = await syncToHF(store, config);
    store.mute(() => {
      const cfg = store.getConfig();
      store.setConfig({
        hfLastUploadAt: r.ok ? new Date().toISOString() : cfg.hfLastUploadAt || null,
        hfLastError: r.ok ? null : (r.errors || []).join('; ') || null,
      });
    });
    return r;
  } catch (err) {
    store.mute(() => store.setConfig({ hfLastError: err.message }));
    return { ok: false, error: err.message };
  }
}

export async function maybeSendDigest(store, config) {
  if (!shouldSendDigest(store, config)) return false;
  await sendTelegram(config, buildDigest(store, config));
  store.setConfig({ lastSummaryDate: new Date().toISOString().slice(0, 10) });
  return true;
}

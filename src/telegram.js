export function telegramConfigured(config) {
  return !!config.telegramBotToken && config.telegramUserIds.length > 0;
}

export async function sendTelegram(config, text) {
  if (!telegramConfigured(config)) return { ok: false, reason: 'Telegram not configured' };
  const results = [];
  for (const chatId of config.telegramUserIds) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      });
      const body = await res.json().catch(() => null);
      results.push({ chatId, ok: res.ok, error: body?.description || null });
    } catch (err) {
      results.push({ chatId, ok: false, error: err.message });
    }
  }
  return { ok: results.every((r) => r.ok), results };
}

export function buildChangeAlert(username, result) {
  const lines = [`🔔 <b>@${username} Update</b>`, `Found ${result.changeCount} change${result.changeCount === 1 ? '' : 's'}:`];
  const types = [];
  const counts = {};
  for (const c of result.changes || []) {
    if (c.type === 'story') counts.story = (counts.story || 0) + 1;
    else if (c.type === 'post') counts.post = (counts.post || 0) + 1;
    else if (c.type === 'avatar') counts.avatar = (counts.avatar || 0) + 1;
    else counts[c.field || c.type] = (counts[c.field || c.type] || 0) + 1;
  }
  const label = { story: 'Stories Saved 📸', post: 'New Posts 🖼️', avatar: 'Profile Picture Changed 👤', fullName: 'Display Name Changed 📛', biography: 'Bio Changed 📝', followersCount: 'Follower Count Changed 📈', postsCount: 'Post Count Changed 📊', isPrivate: 'Privacy Changed 🔒' };
  for (const [key, count] of Object.entries(counts)) {
    types.push(`  • ${count} × ${label[key] || key}`);
  }
  lines.push(...types);
  if (result.newStories) lines.push(`\n📥 ${result.newStories} new stor${result.newStories === 1 ? 'y' : 'ies'} downloaded`);
  lines.push(`\n⏱️ <i>Polled at ${new Date(result.at).toLocaleString([], { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} IST</i>`);
  return lines.join('\n');
}

export function buildDigest(store, config) {
  const cfg = store.getConfig();
  const h = store.getHistory();
  const lines = ['[Instagram Monitor] Daily summary', `Date: ${new Date().toLocaleDateString([], { timeZone: 'Asia/Kolkata' })}`];
  lines.push(`Snapshots: ${cfg.totalSnapshots || 0} · Total changes: ${cfg.totalChanges || 0}`);
  for (const p of cfg.profiles || []) {
    const snaps = (h.profiles[p.username] || []).filter((s) => Date.parse(s.at) >= Date.now() - 24 * 60 * 60 * 1000);
    let changes = 0;
    let stories = 0;
    for (const s of snaps) {
      changes += s.changeCount || 0;
      for (const c of s.changes || []) if (c.type === 'story') stories += 1;
    }
    lines.push(`@${p.username}: ${changes} change${changes === 1 ? '' : 's'} in last 24h${stories ? ` (${stories} stor${stories === 1 ? 'y' : 'ies'})` : ''}`);
  }
  lines.push(`Profiles tracked: ${(cfg.profiles || []).length}`);
  return lines.join('\n');
}

export function shouldSendDigest(store, config, now = new Date()) {
  const cfg = store.getConfig();
  if (cfg.summaryEnabled === false || !telegramConfigured(config)) return false;
  const hour = Number(cfg.summaryHour) || config.summaryHour;
  if (now.getHours() !== hour) return false;
  const today = now.toISOString().slice(0, 10);
  return cfg.lastSummaryDate !== today;
}

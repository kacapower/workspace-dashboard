const app = document.getElementById('app');
const toastEl = document.getElementById('toast');

let status = null;
let historyData = null;
let activeAccount = 'all';
let lbWindow = 'all';
let lbSort = { key: 'changes', dir: -1 };
let page = 'dashboard';
let lastStatusKey = '';

const INTERVALS = [1, 2, 3, 4, 6, 8, 12, 24];
const RETENTION_OPTIONS = [3, 7, 14, 30];
const DRIVER_COLORS = ['#e10600', '#ff8700', '#00d2be', '#005aff', '#f9006d', '#1e41ff', '#00f5d0', '#ff2ed1', '#50c878', '#7cb342', '#e4e4e4', '#4e9a51'];

const ICONS = {
  dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  leaderboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0V4z"/><path d="M17 5h4v2a3 3 0 0 1-3 3"/><path d="M7 5H3v2a3 3 0 0 0 3 3"/></svg>',
  config: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  data: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
  gallery: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>',
  quota: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
  graphs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>',
  logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></svg>',
};

const PAGES = [
  { id: 'dashboard', label: 'Dashboard', icon: ICONS.dashboard },
  { id: 'leaderboard', label: 'Leaderboard', icon: ICONS.leaderboard },
  { id: 'graphs', label: 'Graphs', icon: ICONS.graphs },
  { id: 'quota', label: 'API Quota', icon: ICONS.quota },
  { id: 'config', label: 'Config', icon: ICONS.config },
  { id: 'data', label: 'Data', icon: ICONS.data },
  { id: 'gallery', label: 'Gallery', icon: ICONS.gallery },
];

let graphUser = null;
let graphWindow = '30';

const $ = (sel) => app.querySelector(sel);

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* no json */
  }
  if (!res.ok) {
    throw new Error((body && body.error) || `Request failed (${res.status})`);
  }
  return body;
}

function showToast(message, ok = true) {
  toastEl.textContent = message;
  toastEl.classList.remove('hidden', 'toast-show');
  toastEl.style.background = ok ? '#1ba673' : '#ff5530';
  void toastEl.offsetWidth;
  toastEl.classList.add('toast-show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    toastEl.classList.add('hidden');
    toastEl.classList.remove('toast-show');
  }, 3200);
}

function fmtTime(iso) {
  if (!iso) return 'never';
  const d = new Date(iso);
  return d.toLocaleString([], { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' IST';
}

function fmtBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fieldLabel(field) {
  return {
    fullName: 'Display name',
    biography: 'Bio',
    followersCount: 'Followers',
    followingCount: 'Following',
    postsCount: 'Post count',
    externalUrl: 'Website',
    isPrivate: 'Private',
    profilePic: 'Profile picture',
  }[field] || field;
}

function mediaUrl(username, file) {
  return file ? `/api/media/${encodeURIComponent(username)}/${encodeURIComponent(file)}` : null;
}

function changeItem(username, change) {
  if (change.type === 'avatar') {
    return `
      <div class="flex items-center gap-4">
        <div class="flex items-center gap-2">
          ${change.from ? `<img class="h-14 w-14 rounded-full border border-[#eaecf0] object-cover" src="${escapeHtml(mediaUrl(username, change.from))}" alt="old avatar" />` : ''}
          <span class="text-[#8e8e93]">→</span>
          ${change.to ? `<img class="h-14 w-14 rounded-full border border-[#eaecf0] object-cover" src="${escapeHtml(mediaUrl(username, change.to))}" alt="new avatar" />` : ''}
        </div>
        <div class="text-sm font-semibold">${fieldLabel(change.field)} changed</div>
      </div>`;
  }
  if (change.type === 'field') {
    const rawBefore = change.from ? String(change.from) : '—';
    const rawAfter = change.to ? String(change.to) : 'removed';
    const before = change.from ? escapeHtml(rawBefore) : '<span class="text-[#a8aab2]">—</span>';
    const after = change.to ? escapeHtml(rawAfter) : '<span class="text-[#a8aab2]">removed</span>';
    return `
      <div class="text-sm py-1 border-b border-[#eaecf0] dark:border-[#2a3441] last:border-0 flex items-center justify-between">
        <span class="font-semibold text-[#8e8e93]">${fieldLabel(change.field)}</span>
        <div class="flex items-center gap-2 text-right">
          <span class="text-[#a8aab2] line-through truncate max-w-[100px]" title="${escapeHtml(rawBefore)}">${before}</span>
          <span class="text-[#ff5530] font-medium truncate max-w-[150px]" title="${escapeHtml(rawAfter)}">${after}</span>
        </div>
      </div>`;
  }
  if (change.type === 'post') {
    const info = change.to || {};
    const img = info.mediaFile ? `<img class="w-10 h-10 rounded-md object-cover flex-shrink-0" src="${escapeHtml(mediaUrl(username, info.mediaFile))}" alt="post" />` : '';
    const permalink = info.shortcode ? `https://www.instagram.com/p/${escapeHtml(info.shortcode)}/` : null;
    const time = info.timestamp ? `<span class="text-[10px] text-[#8e8e93]">${fmtTime(info.timestamp)}</span>` : '';
    return `
      <div class="flex items-center gap-3 py-2 border-b border-[#eaecf0] dark:border-[#2a3441] last:border-0">
        ${img}
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="chip chip-info !py-0 !px-1 text-[10px]">New Post</span>
            ${time}
          </div>
          <div class="text-xs text-[#45515e] dark:text-[#a8b3c0] truncate mt-0.5">
            ${info.caption ? escapeHtml(info.caption) : '<i class="text-[#a8aab2]">No caption</i>'}
          </div>
        </div>
        ${permalink ? `<a href="${permalink}" target="_blank" rel="noopener" class="text-xs text-[#1456f0] flex-shrink-0">View</a>` : ''}
      </div>`;
  }
  if (change.type === 'story') {
    return `<div class="text-xs py-1 border-b border-[#eaecf0] dark:border-[#2a3441] last:border-0 flex justify-between"><span class="font-semibold text-[#8e8e93]">New Story</span> <span>${fmtTime(change.to?.timestamp)}</span></div>`;
  }
  if (change.type === 'removed') {
    return `<div class="text-xs py-1 border-b border-[#eaecf0] dark:border-[#2a3441] last:border-0"><span class="text-[#ff5530] font-semibold">Post Removed</span> ${change.from ? escapeHtml(change.from) : ''}</div>`;
  }
  return '<div class="text-xs text-[#45515e] py-1">Unknown change</div>';
}

function renderStories(username, stories) {
  if (!stories || !stories.length) return '';
  return `
    <div>
      <div class="flex items-center gap-2 mb-2">
        <span class="chip chip-story">New stories saved</span>
        <span class="text-xs text-[#8e8e93]">${stories.length} saved</span>
      </div>
      <div class="grid grid-cols-3 sm:grid-cols-4 gap-2">
        ${stories.map((s) => {
          const img = s.mediaFile ? `<img class="aspect-square w-full rounded-lg object-cover border border-[#eaecf0]" src="${escapeHtml(mediaUrl(username, s.mediaFile))}" alt="story" />` : '';
          return `<div class="relative">${img}${s.isHighlight ? '<span class="absolute bottom-1 left-1 text-[10px] font-bold bg-black/60 text-white rounded-full px-2 py-0.5">HL</span>' : ''}</div>`;
        }).join('')}
      </div>
    </div>`;
}

function latestAvatar(username) {
  const list = ((historyData || {}).profiles || {})[username] || [];
  if (!list.length) return null;
  return list[list.length - 1].profile.profilePicFile || null;
}

function latestSnapshot(username) {
  const list = ((historyData || {}).profiles || {})[username] || [];
  return list.length ? list[list.length - 1] : null;
}

/* ---------- Sparklines ---------- */

function followerSeries(username) {
  const list = ((historyData || {}).profiles || {})[username] || [];
  return list
    .map((s) => (s.profile && typeof s.profile.followersCount === 'number' ? s.profile.followersCount : null))
    .filter((v) => v !== null);
}

function drawSpark(canvas) {
  const vals = followerSeries(canvas.dataset.spark);
  if (vals.length < 2) {
    canvas.style.display = 'none';
    return;
  }
  const cssW = Math.max(canvas.clientWidth || 120, 60);
  const cssH = 36;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const step = (cssW - 4) / (vals.length - 1);
  const pts = vals.map((v, i) => [2 + i * step, cssH - 6 - ((v - min) / range) * (cssH - 12)]);
  const rising = vals[vals.length - 1] >= vals[0];
  const color = rising ? '#1ba673' : '#ff5530';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (const [x, y] of pts) ctx.lineTo(x, y);
  ctx.stroke();
  const g = ctx.createLinearGradient(0, 0, 0, cssH);
  g.addColorStop(0, color + '30');
  g.addColorStop(1, color + '00');
  ctx.fillStyle = g;
  ctx.lineTo(pts[pts.length - 1][0], cssH - 6);
  ctx.lineTo(pts[0][0], cssH - 6);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.arc(pts[pts.length - 1][0], pts[pts.length - 1][1], 2.4, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function renderSparks(scope) {
  (scope || document).querySelectorAll('canvas[data-spark]').forEach(drawSpark);
}

function avatarInitial(username) {
  return (username || '?').charAt(0).toUpperCase();
}

/* ---------- Profile stat cards ---------- */

function profileStatCard(username) {
  const snap = latestSnapshot(username);
  const meta = (status.profiles || []).find((p) => p.username === username);
  const avatar = latestAvatar(username);
  const count = (v) => (typeof v === 'number' ? v.toLocaleString() : '—');
  const statBox = (label, value) => `
    <div class="flex flex-col items-center rounded-xl bg-[#f7f8fa] dark:bg-[#1c2430] py-2.5">
      <div class="font-bold tabular-nums text-sm">${escapeHtml(value)}</div>
      <div class="text-[10px] font-semibold text-[#8e8e93] uppercase tracking-wide mt-0.5">${label}</div>
    </div>`;
  if (!snap) {
    return `
      <div class="card p-4 card-enter">
        <div class="flex items-center gap-3">
          <span class="flex h-12 w-12 items-center justify-center rounded-full bg-[#e7e9ee] dark:bg-[#262d38] font-bold text-[#8e8e93]">${avatarInitial(username)}</span>
          <div class="min-w-0">
            <div class="font-bold truncate">@${escapeHtml(username)}</div>
            <div class="text-xs text-[#8e8e93]">no data yet</div>
          </div>
        </div>
      </div>`;
  }
  const prof = snap.profile || {};
  const bio = prof.biography ? `<p class="mt-3 text-xs text-[#5f5f5f] dark:text-[#a8b3c0] line-clamp-2">${escapeHtml(prof.biography)}</p>` : '';
  const privateBadge = prof.isPrivate ? '<span class="chip chip-idle">private</span>' : '';
  const storiesBadge = meta && meta.trackStories ? '<span class="chip chip-story">stories</span>' : '';
  return `
    <div class="card p-4 card-enter">
      <div class="flex items-center gap-3">
        ${avatar
          ? `<img class="h-12 w-12 rounded-full border border-[#eaecf0] dark:border-[#262d38] object-cover" src="${escapeHtml(mediaUrl(username, avatar))}" alt="" />`
          : `<span class="flex h-12 w-12 items-center justify-center rounded-full bg-[#e7e9ee] dark:bg-[#262d38] font-bold text-[#8e8e93]">${avatarInitial(username)}</span>`}
        <div class="min-w-0 flex-1">
          <div class="font-bold truncate">@${escapeHtml(username)}</div>
          <div class="mt-1 flex flex-wrap gap-1">${privateBadge}${storiesBadge}</div>
        </div>
        <div class="text-right">
          <div class="text-[10px] text-[#8e8e93] font-semibold uppercase tracking-wide">last change</div>
          <div class="text-xs font-semibold mt-0.5">${fmtTime(snap.at)}</div>
        </div>
      </div>
      <div class="mt-3 grid grid-cols-3 gap-2">
        ${statBox('followers', count(prof.followersCount))}
        ${statBox('following', count(prof.followingCount))}
        ${statBox('posts', count(prof.postsCount))}
      </div>
      <div class="mt-3">
        <div class="flex items-center justify-between mb-1">
          <span class="text-[10px] font-semibold text-[#8e8e93] uppercase tracking-wide">follower trend</span>
        </div>
        <canvas data-spark="${escapeHtml(username)}"></canvas>
      </div>
      ${bio}
    </div>`;
}

function renderProfileCards() {
  const usernames = visibleAccounts();
  if (!usernames.length) return '';
  return `
    <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      ${usernames.map((u, i) => `<div style="animation-delay:${i * 60}ms">${profileStatCard(u)}</div>`).join('')}
    </div>`;
}

/* ---------- Lightbox ---------- */

const lightbox = { items: [], index: 0 };

function openLightbox(items, index) {
  lightbox.items = items;
  lightbox.index = index;
  const el = document.getElementById('lightbox');
  el.classList.add('show');
  el.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  renderLightbox();
}

function closeLightbox() {
  const el = document.getElementById('lightbox');
  el.classList.remove('show');
  el.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

function renderLightbox() {
  const el = document.getElementById('lightbox');
  const item = lightbox.items[lightbox.index];
  if (!item) return closeLightbox();
  const isVideo = /\.(mp4|webm)$/i.test(item.url);
  const media = isVideo
    ? `<video src="${escapeHtml(item.url)}" controls autoplay playsinline class="max-h-[74vh] max-w-full rounded-2xl"></video>`
    : `<img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.username)}" />`;
  el.querySelector('.lb-media').innerHTML = media;
  el.querySelector('.lb-caption').innerHTML =
    `@${escapeHtml(item.username)} · ${escapeHtml(item.kind)}${isVideo ? ' · video' : ''} · ${lightbox.index + 1} of ${lightbox.items.length}`;
  const prev = el.querySelector('.lb-prev');
  const next = el.querySelector('.lb-next');
  prev.style.visibility = lightbox.items.length > 1 ? '' : 'hidden';
  next.style.visibility = lightbox.items.length > 1 ? '' : 'hidden';
}

function moveLightbox(dir) {
  const len = lightbox.items.length;
  if (!len) return;
  lightbox.index = (lightbox.index + dir + len) % len;
  renderLightbox();
}

function profileBadges(profile) {
  const badges = [];
  if (profile.isPrivate) badges.push('<span class="chip chip-idle">private</span>');
  if (profile.isPrivate) badges.push(`<span class="chip chip-info">batched ${profile.intervalHours}h</span>`);
  if (profile.backfill) badges.push('<span class="chip chip-idle">previous downloaded</span>');
  if (profile.trackStories) badges.push('<span class="chip chip-story">stories</span>');
  return badges.join(' ');
}

function renderProfilesNav() {
  const profiles = status.profiles || [];
  const items = [
    `<button class="nav-pill ${activeAccount === 'all' ? 'active' : ''}" data-account="all">All</button>`,
    ...profiles.map((p) => `
      <button class="nav-pill ${activeAccount === p.username ? 'active' : ''}" data-account="${escapeHtml(p.username)}">
        @${escapeHtml(p.username)}${p.isPrivate ? ' · private' : ''}
      </button>`),
  ];
  return `<div class="flex flex-wrap gap-2">${items.join('')}</div>`;
}

function visibleAccounts() {
  const profiles = status.profiles || [];
  if (activeAccount === 'all') return profiles.map((p) => p.username);
  return profiles.some((p) => p.username === activeAccount) ? [activeAccount] : [];
}

function renderProfileTimeline(username) {
  const list = ((historyData || {}).profiles || {})[username] || [];
  if (!list.length) {
    return `<div class="text-center py-8 text-[#8e8e93]">No snapshots yet. Run the first poll from Config.</div>`;
  }
  const reversed = [...list].reverse();
  return `
    <div class="relative space-y-6 pl-6 border-l border-[#eaecf0] dark:border-[#262d38]">
      ${reversed.map((snap) => `
        <div class="relative fade-in">
          <span class="absolute -left-[31px] top-1 h-3 w-3 rounded-full border-2 border-[#0a0a0a] dark:border-white bg-white dark:bg-[#0d1117]"></span>
          <div class="card p-5">
            <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div class="flex items-center gap-2">
                <span class="font-semibold">${fmtTime(snap.at)}</span>
                ${snap.profile.isPrivate ? '<span class="chip chip-idle">private · avatar only</span>' : ''}
              </div>
              ${snap.changeCount > 0
                ? `<span class="chip chip-error">${snap.changeCount} change${snap.changeCount === 1 ? '' : 's'}</span>`
                : `<span class="chip chip-ok">No changes</span>`}
            </div>
            ${snap.changeCount > 0 ? `<div class="flex flex-col gap-4">${snap.changes.map((c) => changeItem(username, c)).join('')}</div>` : ''}
            ${renderStories(username, snap.stories)}
          </div>
        </div>
      `).join('')}
    </div>`;
}

function renderHistorySections() {
  const usernames = visibleAccounts();
  if (!usernames.length) {
    return `<div class="text-[#8e8e93] text-sm py-8 text-center">No profiles yet. Add your first Instagram profile in Config.</div>`;
  }
  return usernames.map((username) => `
    <section class="card p-6">
      <div class="flex items-center justify-between gap-3 mb-5">
        <h2 class="text-lg font-bold truncate">@${escapeHtml(username)}</h2>
      </div>
      <div id="timeline-${escapeHtml(username)}">${renderProfileTimeline(username)}</div>
    </section>
  `).join('');
}

/* ---------- Leaderboard ---------- */

function leaderboardRows() {
  const now = Date.now();
  const cutoff = lbWindow === 'all' ? null : now - Number(lbWindow) * 86400000;
  const rows = [];
  (status.profiles || []).forEach((p) => {
    const snaps = ((historyData?.profiles || {})[p.username] || []).filter((s) => !cutoff || Date.parse(s.at) >= cutoff);
    let changes = 0;
    let posts = 0;
    let stories = 0;
    let avatars = 0;
    for (const s of snaps) {
      changes += s.changeCount || 0;
      for (const c of s.changes || []) {
        if (c.type === 'post') posts += 1;
        else if (c.type === 'story') stories += 1;
        else if (c.type === 'avatar') avatars += 1;
      }
    }
    let followers = null;
    if (snaps.length >= 2) {
      const first = snaps[0].profile?.followersCount;
      const last = snaps[snaps.length - 1].profile?.followersCount;
      if (typeof first === 'number' && typeof last === 'number') followers = last - first;
    }
    rows.push({ username: p.username, isPrivate: p.isPrivate, changes, posts, stories, avatars, followers, snapCount: snaps.length });
  });
  const { key, dir } = lbSort;
  rows.sort((a, b) => {
    const av = a[key] ?? -Infinity;
    const bv = b[key] ?? -Infinity;
    return (av < bv ? -1 : av > bv ? 1 : 0) * dir;
  });
  return rows;
}

function posBadge(pos) {
  if (pos === 1) return '<span class="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[#ffd700] font-bold text-[#1a1a1a]">P1</span>';
  if (pos === 2) return '<span class="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[#c7ccd4] font-bold text-[#1a1a1a]">P2</span>';
  if (pos === 3) return '<span class="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[#cd7f32] font-bold text-white">P3</span>';
  return `<span class="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[#e7e9ee] dark:bg-[#262d38] font-bold text-[#5f5f5f] dark:text-[#a8b3c0]">${pos}</span>`;
}

function followerCell(value) {
  if (value === null || value === undefined) return '<span class="text-[#a8aab2]">—</span>';
  if (value === 0) return '<span class="text-[#8e8e93]">0</span>';
  const sign = value > 0 ? '+' : '';
  return `<span class="font-bold ${value > 0 ? 'text-[#1ba673]' : 'text-[#ff5530]'}">${sign}${value.toLocaleString()}</span>`;
}

function leaderboardTable() {
  const rows = leaderboardRows();
  const cols = [
    { key: 'changes', label: 'Changes' },
    { key: 'posts', label: 'New posts' },
    { key: 'stories', label: 'Stories' },
    { key: 'avatars', label: 'Avatars' },
    { key: 'followers', label: 'Followers Δ' },
  ];
  if (!rows.length) return '<p class="text-[#8e8e93] text-sm py-8 text-center">No profiles to rank yet.</p>';
  const header = cols.map((c) => {
    const active = lbSort.key === c.key;
    const arrow = active ? (lbSort.dir === -1 ? ' ▼' : ' ▲') : '';
    return `<button class="lb-sort font-semibold text-[#45515e] dark:text-[#a8b3c0] text-xs uppercase tracking-wide hover:text-[#0a0a0a] ${active ? 'text-[#0a0a0a] dark:text-white' : ''}" data-key="${c.key}">${c.label}${arrow}</button>`;
  }).join('');
  return `
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-[#eaecf0] dark:border-[#262d38]">
            <th class="text-left py-2 pr-3 text-xs font-semibold text-[#8e8e93] uppercase tracking-wide w-14">Pos</th>
            <th class="text-left py-2 pr-3 text-xs font-semibold text-[#8e8e93] uppercase tracking-wide">Profile</th>
            <th class="text-right py-2 px-2 text-xs font-semibold text-[#8e8e93] uppercase tracking-wide">Trend</th>
            ${cols.map((c) => `<th class="text-right py-2 px-2">${header[cols.indexOf(c)]}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${rows.map((r, i) => {
            const accent = DRIVER_COLORS[i % DRIVER_COLORS.length];
            const avatar = latestAvatar(r.username);
            return `
              <tr class="border-b border-[#f0f1f4] dark:border-[#20242e] last:border-0">
                <td class="py-3 pr-3">${posBadge(i + 1)}</td>
                <td class="py-3 pr-3">
                  <div class="flex items-center gap-3">
                    <span class="inline-block h-2.5 w-2.5 rounded-full shrink-0" style="background:${accent}"></span>
                    ${avatar ? `<img class="h-8 w-8 rounded-full border border-[#eaecf0] object-cover" src="${escapeHtml(mediaUrl(r.username, avatar))}" alt="" />` : ''}
                    <div class="min-w-0">
                      <div class="font-semibold truncate">@${escapeHtml(r.username)}${r.isPrivate ? ' <span class="text-[#8e8e93]">· private</span>' : ''}</div>
                      <div class="text-[10px] text-[#8e8e93]">${r.snapCount} snapshot${r.snapCount === 1 ? '' : 's'}</div>
                    </div>
                  </div>
                </td>
                <td class="py-3 px-2"><canvas data-spark="${escapeHtml(r.username)}"></canvas></td>
                <td class="py-3 px-2 text-right font-bold tabular-nums">${r.changes}</td>
                <td class="py-3 px-2 text-right tabular-nums">${r.posts}</td>
                <td class="py-3 px-2 text-right tabular-nums">${r.stories}</td>
                <td class="py-3 px-2 text-right tabular-nums">${r.avatars}</td>
                <td class="py-3 px-2 text-right">${followerCell(r.followers)}</td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

/* ---------- Pages ---------- */

function pageHeader(title, subtitle) {
  return `
    <header class="mb-6">
      <h1 class="text-2xl font-bold tracking-tight">${title}</h1>
      <p class="text-sm text-[#5f5f5f] dark:text-[#a8b3c0] mt-1">${subtitle}</p>
    </header>`;
}

function renderDashboardPage() {
  const s = status;
  const pollStatusChip =
    s.lastPollStatus === 'ok' ? `<span class="chip chip-ok">Last poll ok</span>`
    : s.lastPollStatus === 'running' ? `<span class="chip chip-info">Polling…</span>`
    : s.lastPollStatus === 'partial' ? `<span class="chip chip-error">Some profiles failed</span>`
    : s.lastPollStatus === 'error' ? `<span class="chip chip-error">Last poll failed</span>`
    : `<span class="chip chip-idle">No poll yet</span>`;

  $('#main').innerHTML = `
    ${pageHeader('Dashboard', 'Overview of every tracked profile over time.')}
    <div class="flex flex-wrap items-center justify-between gap-3 mb-6">
      <div class="flex items-center gap-2">
        <span class="chip chip-ok"><span class="live-dot"></span>live</span>
        ${pollStatusChip}
      </div>
      ${renderProfilesNav()}
    </div>
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center mb-6">
      <div class="rounded-2xl bg-[#f7f8fa] dark:bg-[#1c2430] p-4"><div class="text-2xl font-bold">${s.totalSnapshots}</div><div class="text-xs font-semibold text-[#8e8e93] mt-1">snapshots</div></div>
      <div class="rounded-2xl bg-[#f7f8fa] dark:bg-[#1c2430] p-4"><div class="text-2xl font-bold text-[#ff5530]">${s.totalChanges}</div><div class="text-xs font-semibold text-[#8e8e93] mt-1">changes</div></div>
      <div class="rounded-2xl bg-[#f7f8fa] dark:bg-[#1c2430] p-4"><div class="text-sm font-bold">${fmtTime(s.lastPollAt)}</div><div class="text-xs font-semibold text-[#8e8e93] mt-1">last poll</div></div>
      <div class="rounded-2xl bg-[#f7f8fa] dark:bg-[#1c2430] p-4"><div class="text-sm font-bold">${fmtTime(s.nextPollAt)}</div><div class="text-xs font-semibold text-[#8e8e93] mt-1">next poll</div></div>
    </div>
    ${renderProfileCards()}
    <div class="grid gap-6 mt-6">${renderHistorySections()}</div>`;

  renderSparks($('#main'));

  app.querySelectorAll('.nav-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeAccount = btn.dataset.account;
      renderDashboardPage();
    });
  });
}

function renderLeaderboardPage() {
  $('#main').innerHTML = `
    ${pageHeader('Leaderboard', 'F1-style standings — ranked by activity, click a column to re-rank.')}
    <div class="flex gap-2 mb-5">
      ${[['all', 'All-time'], ['7', '7 days'], ['30', '30 days']].map(([key, label]) => `
        <button class="btn-pill ${lbWindow === key ? 'btn-primary' : 'btn-tertiary'} lb-window" data-window="${key}">${label}</button>`).join('')}
    </div>
    <div class="card p-6">
      <div id="leaderboard"></div>
    </div>`;
  renderLeaderboardTable();
  app.querySelectorAll('.lb-window').forEach((btn) => {
    btn.addEventListener('click', () => {
      lbWindow = btn.dataset.window;
      renderLeaderboardPage();
    });
  });
}

function renderLeaderboardTable() {
  const box = $('#leaderboard');
  if (!box) return;
  box.innerHTML = leaderboardTable();
  renderSparks(box);
  box.querySelectorAll('.lb-sort').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      if (lbSort.key === key) lbSort.dir = -lbSort.dir;
      else lbSort = { key, dir: -1 };
      renderLeaderboardTable();
    });
  });
}

function renderGraphsPage() {
  const profiles = status?.profiles || [];
  if (!profiles.length) {
    $('#main').innerHTML = `${pageHeader('Graphs', 'Visualize follower growth over time.')}<div class="card p-6 text-[#8e8e93]">No profiles tracked yet.</div>`;
    return;
  }
  
  if (!graphUser) graphUser = profiles[0].username;

  const userOpts = profiles.map(p => `<option value="${escapeHtml(p.username)}" ${graphUser === p.username ? 'selected' : ''}>@${escapeHtml(p.username)}</option>`).join('');
  
  const windowOpts = [
    ['7', '1 Week'],
    ['30', '1 Month'],
    ['90', '3 Months'],
    ['180', '6 Months'],
    ['365', '1 Year'],
    ['all', 'All-time']
  ];

  $('#main').innerHTML = `
    ${pageHeader('Graphs', 'Track follower and following trends over time.')}
    <div class="flex flex-col sm:flex-row gap-3 mb-5">
      <select id="graph-user-select" class="input w-full sm:w-64">${userOpts}</select>
      <div class="flex gap-2 flex-wrap">
        ${windowOpts.map(([key, label]) => `
          <button class="btn-pill ${graphWindow === key ? 'btn-primary' : 'btn-tertiary'} graph-window" data-window="${key}">${label}</button>`).join('')}
      </div>
    </div>
    <div class="card p-6 flex flex-col h-[65vh] min-h-[400px]">
      <div class="relative w-full h-full flex-grow">
        <canvas id="userChart"></canvas>
      </div>
    </div>`;

  setTimeout(drawUserChart, 0);

  $('#graph-user-select').addEventListener('change', (e) => {
    graphUser = e.target.value;
    renderGraphsPage();
  });

  app.querySelectorAll('.graph-window').forEach((btn) => {
    btn.addEventListener('click', () => {
      graphWindow = btn.dataset.window;
      renderGraphsPage();
    });
  });
}

function drawUserChart() {
  const canvas = document.getElementById('userChart');
  if (!canvas || !window.Chart) return;

  const snaps = (historyData?.profiles || {})[graphUser] || [];
  const now = Date.now();
  const cutoff = graphWindow === 'all' ? null : now - Number(graphWindow) * 86400000;

  const filtered = snaps.filter(s => (!cutoff || Date.parse(s.at) >= cutoff) && s.profile);
  
  const dates = [];
  const followers = [];
  const following = [];

  for (const s of filtered) {
    dates.push(new Date(s.at).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
    followers.push(s.profile.followersCount || 0);
    following.push(s.profile.followingCount || 0);
  }

  if (window.myUserChart) window.myUserChart.destroy();
  
  if (!dates.length) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = '14px sans-serif';
    ctx.fillStyle = '#8e8e93';
    ctx.textAlign = 'center';
    ctx.fillText('Not enough data yet', canvas.width/2, canvas.height/2);
    return;
  }

  window.myUserChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: dates,
      datasets: [
        {
          label: 'Followers',
          data: followers,
          borderColor: '#1ba673',
          backgroundColor: '#1ba67320',
          yAxisID: 'y',
          tension: 0.3,
          fill: true,
          borderWidth: 2,
          pointRadius: 2
        },
        {
          label: 'Following',
          data: following,
          borderColor: '#ff5530',
          backgroundColor: 'transparent',
          yAxisID: 'y1',
          tension: 0.3,
          fill: false,
          borderWidth: 2,
          pointRadius: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { display: false } },
        y: { 
          type: 'linear', 
          display: true, 
          position: 'left',
          title: { display: true, text: 'Followers' },
          ticks: { precision: 0 }
        },
        y1: { 
          type: 'linear', 
          display: true, 
          position: 'right',
          title: { display: true, text: 'Following' },
          grid: { drawOnChartArea: false },
          ticks: { precision: 0 }
        }
      },
      plugins: {
        legend: { position: 'bottom', labels: { usePointStyle: true } }
      },
      interaction: { mode: 'index', intersect: false }
    }
  });
}

function renderConfigPage() {
  const s = status;
  const autoInterval = (p) => p.isPrivate ? p.batchIntervalHours || s.batchIntervalHours : s.intervalHours;
  const profiles = (s.profiles || []).map((p, idx) => {
    const avatar = latestAvatar(p.username);
    const accent = DRIVER_COLORS[idx % DRIVER_COLORS.length];
    const current = Number.isFinite(p.intervalHours) ? p.intervalHours : null;
    return `
      <div class="flex items-center gap-4 rounded-2xl bg-[#f7f8fa] dark:bg-[#1c2430] p-3 border-l-4" style="border-left-color:${accent}">
        ${avatar ? `<img class="h-11 w-11 rounded-full border border-[#eaecf0] object-cover" src="${escapeHtml(mediaUrl(p.username, avatar))}" alt="" />` : ''}
        <div class="min-w-0 flex-1">
          <div class="font-semibold truncate">@${escapeHtml(p.username)}</div>
          <div class="mt-1 flex flex-wrap gap-1">${profileBadges(p)}</div>
        </div>
        <div class="flex flex-col items-end gap-1">
          <div class="flex items-center gap-2">
            <span class="text-[10px] text-[#8e8e93]">every</span>
            <select class="input !py-1 !px-2 text-xs interval-select" data-username="${escapeHtml(p.username)}">
              <option value="auto" ${current === null ? 'selected' : ''}>auto (${autoInterval(p)}h)</option>
              ${INTERVALS.map((h) => `<option value="${h}" ${current === h ? 'selected' : ''}>${h}h</option>`).join('')}
            </select>
          </div>
          <div class="flex gap-2">
            <button class="rename-profile btn-pill btn-tertiary !px-3 !py-1.5 text-xs" data-username="${escapeHtml(p.username)}">Rename</button>
            <button class="remove-profile btn-pill btn-tertiary !px-3 !py-1.5 text-xs" data-username="${escapeHtml(p.username)}">Remove</button>
          </div>
        </div>
      </div>`;
  }).join('');

  $('#main').innerHTML = `
    ${pageHeader('Config', 'Profiles, polling intervals and alerts.')}

    <section class="card p-6 mb-6">
      <h2 class="text-lg font-bold mb-4">Add a profile</h2>
      <form id="add-profile-form" class="flex flex-col gap-3">
        <div class="flex flex-col sm:flex-row gap-3">
          <input class="input flex-1" id="profile-input" placeholder="e.g. @natgeo or https://instagram.com/natgeo" />
          <button type="submit" class="btn-pill btn-primary">Add</button>
        </div>
        <div class="flex flex-wrap items-center gap-6">
          <label class="checkbox-row"><input type="checkbox" id="backfill-input" checked /> Download previous posts</label>
          <label class="checkbox-row"><input type="checkbox" id="stories-input" checked /> Also save stories & highlights</label>
        </div>
      </form>
    </section>

    <section class="card p-6 mb-6">
      <h2 class="text-lg font-bold mb-4">Tracked profiles</h2>
      <div class="flex flex-col gap-2">${profiles || '<p class="text-[#8e8e93] text-sm">No profiles yet.</p>'}</div>
    </section>

    <section class="card p-6 mb-6">
      <h2 class="text-lg font-bold mb-4">Poll interval</h2>
      <div class="flex flex-wrap items-end gap-3">
        <div class="w-full sm:w-48">
          <label class="text-sm font-semibold text-[#45515e] dark:text-[#a8b3c0] block mb-2">Public poll every</label>
          <select class="input" id="interval-input">
            ${INTERVALS.map((h) => `<option value="${h}" ${s.intervalHours === h ? 'selected' : ''}>${h} hour${h === 1 ? '' : 's'}</option>`).join('')}
          </select>
        </div>
        <button id="interval-save" class="btn-pill btn-secondary">Save interval</button>
        <span class="text-xs text-[#8e8e93]">Private accounts are privacy-pinged hourly (cheap, batched) and fully checked every ${s.batchIntervalHours} hour(s) unless overridden per profile. If one goes public it is pulled immediately and you get a Telegram alert.</span>
      </div>
    </section>

    <section class="card p-6 mb-6">
      <h2 class="text-lg font-bold mb-4">Poller status</h2>
      <div class="flex flex-wrap items-center gap-3 mb-4">
        <span class="chip chip-idle">last poll ${fmtTime(s.lastPollAt)}</span>
        <span class="chip chip-idle">next poll ${fmtTime(s.nextPollAt)}</span>
        ${s.lastPollStatus === 'partial' ? '<span class="chip chip-error">some profiles failed</span>' : ''}
        ${!s.storiesEnabled ? '<span class="chip chip-idle">stories off</span>' : ''}
      </div>
      ${s.lastPollError ? `<p class="mb-4 text-sm text-[#ff5530]">${escapeHtml(s.lastPollError)}</p>` : ''}
      ${!s.storiesEnabled ? '<p class="mb-4 text-sm text-[#8e8e93]">Stories tracking is off — set APIFY_STORIES_ACTOR to enable it.</p>' : ''}
      <div class="flex gap-3">
        <button id="poll-now-btn" class="btn-pill btn-primary">Run poll now</button>
        <button id="poll-force-btn" class="btn-pill btn-tertiary">Force poll all</button>
      </div>
    </section>

    <section class="card p-6">
      <h2 class="text-lg font-bold mb-1">Alerts</h2>
      <p class="text-sm text-[#8e8e93] mb-4">${s.telegramEnabled ? 'Telegram bot connected.' : 'Telegram not configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_USER_IDS to enable alerts.'}</p>
      <div class="flex flex-col gap-4">
        <label class="checkbox-row"><input type="checkbox" id="alerts-input" ${s.alertsEnabled ? 'checked' : ''} ${s.telegramEnabled ? '' : 'disabled'} /> Send a message when a profile changes</label>
        <div class="flex flex-wrap items-end gap-3">
          <div class="w-full sm:w-48">
            <label class="text-sm font-semibold text-[#45515e] dark:text-[#a8b3c0] block mb-2">Daily summary at</label>
            <select class="input" id="summary-hour-input" ${s.telegramEnabled ? '' : 'disabled'}>
              ${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${s.summaryHour === h ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}
            </select>
          </div>
          <button id="summary-save" class="btn-pill btn-secondary" ${s.telegramEnabled ? '' : 'disabled'}>Save summary time</button>
          <button id="alerts-test" class="btn-pill btn-tertiary" ${s.telegramEnabled ? '' : 'disabled'}>Send test message</button>
        </div>
      </div>
    </section>`;

  $('#add-profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#profile-input');
    try {
      const r = await api('/api/config/profiles', {
        method: 'POST',
        body: JSON.stringify({ username: input.value, backfill: $('#backfill-input').checked, trackStories: $('#stories-input').checked }),
      });
      input.value = '';
      status.profiles = r.profiles;
      activeAccount = 'all';
      showToast(`Added @${r.username}.`);
      await refresh();
    } catch (err) {
      showToast(err.message, false);
    }
  });

  $('#interval-save').addEventListener('click', async () => {
    try {
      const r = await api('/api/config', { method: 'POST', body: JSON.stringify({ intervalHours: Number($('#interval-input').value) }) });
      status.intervalHours = r.intervalHours;
      showToast(`Public poll interval set to every ${r.intervalHours} hour(s).`);
    } catch (err) {
      showToast(err.message, false);
    }
  });

  $('#summary-save').addEventListener('click', async () => {
    try {
      await api('/api/config', { method: 'POST', body: JSON.stringify({ summaryHour: Number($('#summary-hour-input').value) }) });
      showToast('Daily summary time saved.');
    } catch (err) {
      showToast(err.message, false);
    }
  });

  $('#alerts-input').addEventListener('change', async () => {
    try {
      await api('/api/config', { method: 'POST', body: JSON.stringify({ alertsEnabled: $('#alerts-input').checked }) });
      showToast('Change alerts updated.');
    } catch (err) {
      showToast(err.message, false);
    }
  });

  $('#alerts-test').addEventListener('click', async () => {
    try {
      await api('/api/alerts/test', { method: 'POST' });
      showToast('Test message sent to Telegram.');
    } catch (err) {
      showToast(err.message, false);
    }
  });

  app.querySelectorAll('.interval-select').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const username = sel.dataset.username;
      const value = sel.value === 'auto' ? null : Number(sel.value);
      try {
        const r = await api(`/api/config/profiles/${encodeURIComponent(username)}`, { method: 'PATCH', body: JSON.stringify({ intervalHours: value }) });
        status.profiles = status.profiles.map((p) => (p.username === username ? r.profile : p));
        showToast(`@${username} poll interval updated.`);
        await refresh();
      } catch (err) {
        showToast(err.message, false);
      }
    });
  });

  app.querySelectorAll('.remove-profile').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const username = btn.dataset.username;
      if (!confirm(`Stop tracking @${username}? Snapshots are kept.`)) return;
      try {
        const r = await api(`/api/config/profiles/${encodeURIComponent(username)}`, { method: 'DELETE' });
        status.profiles = r.profiles;
        if (activeAccount === username) activeAccount = 'all';
        showToast(`Removed @${username}.`);
        await refresh();
      } catch (err) {
        showToast(err.message, false);
      }
    });
  });

  app.querySelectorAll('.rename-profile').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const username = btn.dataset.username;
      const to = prompt(`Rename @${username} to?`, username);
      if (!to || to === username) return;
      try {
        const r = await api(`/api/config/profiles/${encodeURIComponent(username)}/rename`, { method: 'POST', body: JSON.stringify({ to }) });
        if (activeAccount === username) activeAccount = r.username;
        showToast(`Renamed @${username} to @${r.username}.`);
        await refresh();
      } catch (err) {
        showToast(err.message, false);
      }
    });
  });

  async function runPoll(force) {
    const btn = force ? $('#poll-force-btn') : $('#poll-now-btn');
    btn.disabled = true;
    btn.textContent = 'Polling…';
    try {
      const r = await api(`/api/poll?force=${force ? '1' : '0'}`, { method: 'POST' });
      const failed = (r.results || []).filter((x) => !x.ok);
      const newStories = (r.results || []).reduce((sum, x) => sum + (x.newStories || 0), 0);
      let msg;
      if (failed.length) msg = `Poll done — ${failed.length} profile(s) errored.`;
      else if (r.polledCount === 0) msg = 'Nothing due yet — use "Force poll all" to check everything now.';
      else if (r.totalChanges || newStories) msg = `Poll done — ${r.totalChanges} change(s), ${newStories} new stor${newStories === 1 ? 'y' : 'ies'} saved.`;
      else msg = 'Poll done — no changes.';
      showToast(msg, failed.length === 0);
      await refresh();
    } catch (err) {
      showToast(err.message, false);
      btn.disabled = false;
      btn.textContent = force ? 'Force poll all' : 'Run poll now';
    }
  }

  $('#poll-now-btn').addEventListener('click', () => runPoll(false));
  $('#poll-force-btn').addEventListener('click', () => runPoll(true));
}

async function renderDataPage() {
  $('#main').innerHTML = `
    ${pageHeader('Data', 'Storage, backups, retention and Hugging Face sync.')}
    <section class="card p-6 mb-6">
      <h2 class="text-lg font-bold mb-4">Storage usage</h2>
      <div id="usage-box"><div class="flex flex-col gap-2">${Array.from({ length: 3 }, () => '<div class="skeleton h-12 rounded-xl"></div>').join('')}</div></div>
    </section>
    <section class="card p-6 mb-6">
      <h2 class="text-lg font-bold mb-4">Downloads</h2>
      <div class="flex flex-wrap gap-3">
        <a class="btn-pill btn-primary" href="/api/backup">Download full backup (ZIP)</a>
      </div>
      <div class="mt-4 flex flex-col gap-2" id="per-profile-downloads"></div>
    </section>
    <section class="card p-6 mb-6">
      <h2 class="text-lg font-bold mb-1">Retention</h2>
      <p class="text-sm text-[#8e8e93] mb-4">Media files (posts & stories) older than the retention window are deleted to save storage. Avatars are never deleted and JSON history is always kept.</p>
      <div class="flex flex-wrap items-end gap-3">
        <div class="w-full sm:w-40">
          <label class="text-sm font-semibold text-[#45515e] dark:text-[#a8b3c0] block mb-2">Keep media for</label>
          <select class="input" id="retention-days-input">
            ${RETENTION_OPTIONS.map((d) => `<option value="${d}" ${status.retentionDays === d ? 'selected' : ''}>${d} days</option>`).join('')}
          </select>
        </div>
        <button id="retention-save" class="btn-pill btn-secondary">Save</button>
        <button id="cleanup-now" class="btn-pill btn-tertiary">Delete old media now</button>
        <label class="checkbox-row"><input type="checkbox" id="retention-input" ${status.retentionEnabled ? 'checked' : ''} /> Auto-delete enabled</label>
      </div>
    </section>
    <section class="card p-6">
      <h2 class="text-lg font-bold mb-1">Hugging Face sync</h2>
      <p class="text-sm text-[#8e8e93] mb-4">Data is pushed to a dataset with a folder per person (e.g. <code class="bg-[#f2f3f5] dark:bg-[#262d38] px-1.5 py-0.5 rounded">@natgeo/</code>) after every poll, with retry on the next attempt.</p>
      ${status.hfEnabled ? `
        <div class="flex flex-wrap items-center gap-3 mb-4">
          <span class="chip chip-info">dataset ${escapeHtml(status.hfDataset)}</span>
          <span class="chip chip-idle">last upload ${fmtTime(status.hfLastUploadAt)}</span>
          ${status.hfLastError ? `<span class="chip chip-error">${escapeHtml(status.hfLastError)}</span>` : ''}
        </div>
        <button id="hf-sync-btn" class="btn-pill btn-primary">Sync now</button>
      ` : `
        <p class="text-sm text-[#ff5530]">Hugging Face is not configured. Set HF_TOKEN and HF_DATASET (e.g. yourname/instagram-monitor) to enable.</p>
      `}
    </section>`;

  const usage = await api('/api/data/usage');
  $('#usage-box').innerHTML = `
    <div class="flex flex-col gap-2">
      ${usage.profiles.map((p) => `
        <div class="flex items-center justify-between rounded-xl bg-[#f7f8fa] dark:bg-[#1c2430] px-4 py-3">
          <span class="font-semibold">@${escapeHtml(p.username)}</span>
          <span class="text-sm text-[#8e8e93]">${p.files} file${p.files === 1 ? '' : 's'} · ${fmtBytes(p.bytes)}</span>
        </div>`).join('')}
      <div class="flex items-center justify-between rounded-xl px-4 py-3 font-bold">
        <span>Total</span>
        <span>${usage.totalFiles} files · ${fmtBytes(usage.totalBytes)}</span>
      </div>
    </div>`;

  $('#per-profile-downloads').innerHTML = (status.profiles || []).map((p) => `
    <a class="btn-pill btn-tertiary justify-start w-full sm:w-auto" href="/api/backup/${encodeURIComponent(p.username)}">Download @${escapeHtml(p.username)} data</a>`).join('');

  $('#retention-input').addEventListener('change', async () => {
    try {
      await api('/api/config', { method: 'POST', body: JSON.stringify({ retentionEnabled: $('#retention-input').checked }) });
      showToast('Retention updated.');
    } catch (err) {
      showToast(err.message, false);
    }
  });

  $('#retention-save').addEventListener('click', async () => {
    try {
      await api('/api/config', { method: 'POST', body: JSON.stringify({ retentionDays: Number($('#retention-days-input').value) }) });
      showToast('Retention window saved.');
    } catch (err) {
      showToast(err.message, false);
    }
  });

  $('#cleanup-now').addEventListener('click', async () => {
    try {
      const r = await api('/api/data/cleanup', { method: 'POST' });
      showToast(r.deleted ? `Deleted ${r.deleted} file(s), freed ${fmtBytes(r.freedBytes)}.` : 'Nothing old to delete.');
      renderDataPage();
    } catch (err) {
      showToast(err.message, false);
    }
  });

  const hfBtn = $('#hf-sync-btn');
  if (hfBtn) {
    hfBtn.addEventListener('click', async () => {
      hfBtn.disabled = true;
      hfBtn.textContent = 'Syncing…';
      try {
        const r = await api('/api/hf/sync', { method: 'POST' });
        showToast(r.errors?.length ? `Synced with ${r.errors.length} error(s).` : `Synced ${r.uploaded} file(s) to HF.`);
        await refresh();
      } catch (err) {
        showToast(err.message, false);
        hfBtn.disabled = false;
        hfBtn.textContent = 'Sync now';
      }
    });
  }
}

async function renderGalleryPage() {
  $('#main').innerHTML = `
    ${pageHeader('Gallery', 'All downloaded media in one grid.')}
    <div class="flex flex-wrap gap-2 mb-5">
      ${[['all', 'All'], ['avatar', 'Avatars'], ['post', 'Posts'], ['story', 'Stories']].map(([k, label]) => `
        <button class="btn-pill ${(gallery.kind || 'all') === k ? 'btn-primary' : 'btn-tertiary'} gallery-kind" data-kind="${k}">${label}</button>`).join('')}
      <select class="input !w-56" id="gallery-user">
        <option value="all">All profiles</option>
        ${(status.profiles || []).map((p) => `<option value="${escapeHtml(p.username)}" ${gallery.user === p.username ? 'selected' : ''}>@${escapeHtml(p.username)}</option>`).join('')}
      </select>
    </div>
    <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3" id="gallery-grid">
      ${Array.from({ length: 8 }, () => '<div class="skeleton aspect-square rounded-xl"></div>').join('')}
    </div>`;

  const kind = gallery.kind || 'all';
  const user = gallery.user || 'all';
  const data = await api('/api/media/all');
  const items = data.items.filter((it) => (kind === 'all' || it.kind === kind) && (user === 'all' || it.username === user));
  const grid = $('#gallery-grid');
  if (!items.length) {
    grid.innerHTML = `
      <div class="col-span-full empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
        <p class="text-sm">No media yet.</p>
        <p class="text-xs">Run a poll to start capturing avatars, posts and stories.</p>
      </div>`;
  } else {
    grid.innerHTML = items.map((it, idx) => {
      const isVideo = /\.(mp4|webm)$/i.test(it.url);
      const tile = isVideo
        ? `<video src="${escapeHtml(it.url)}" preload="metadata" muted loop playsinline class="aspect-square w-full object-cover group-hover:scale-105 transition-transform duration-200"></video>`
        : `<img src="${escapeHtml(it.url)}" loading="lazy" class="aspect-square w-full object-cover group-hover:scale-105 transition-transform duration-200" alt="${escapeHtml(it.username)}" />`;
      return `
      <button type="button" class="lb-open group relative block w-full overflow-hidden rounded-xl border border-[#eaecf0] dark:border-[#262d38] text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1456f0]" data-index="${idx}" aria-label="View media from @${escapeHtml(it.username)}">
        ${tile}
        <div class="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent px-2 py-1.5">
          <div class="text-[10px] font-bold text-white truncate">@${escapeHtml(it.username)} · ${escapeHtml(it.kind)}${isVideo ? ' · video' : ''}</div>
        </div>
        <span class="absolute top-1.5 right-1.5 inline-flex items-center justify-center h-6 w-6 rounded-full bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="h-3.5 w-3.5"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
        </span>
      </button>`;
    }).join('');
  }

  grid.querySelectorAll('.lb-open').forEach((btn) => {
    btn.addEventListener('click', () => openLightbox(items, Number(btn.dataset.index)));
  });

  app.querySelectorAll('.gallery-kind').forEach((btn) => {
    btn.addEventListener('click', () => {
      gallery.kind = btn.dataset.kind;
      renderGalleryPage();
    });
  });
  $('#gallery-user').addEventListener('change', (e) => {
    gallery.user = e.target.value;
    renderGalleryPage();
  });
}

const gallery = { kind: 'all', user: 'all' };

/* ---------- Shell / login / setup ---------- */

function renderShell() {
  app.innerHTML = `
    <header class="sm:hidden sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-[#eaecf0] dark:border-[#262d38] px-4 h-14" style="background: var(--bg)">
      <div class="flex items-center gap-3">
        <button id="menu-btn" class="touch-target inline-flex items-center justify-center rounded-full border border-[#eaecf0] dark:border-[#262d38] px-3 text-[#45515e] dark:text-[#a8b3c0]" aria-label="Open menu">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="h-5 w-5"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>
        </button>
        <div class="font-bold tracking-tight">Instagram Monitor</div>
      </div>
      <div class="text-[10px] text-[#8e8e93] uppercase tracking-wider">change monitor</div>
    </header>

    <div id="scrim" class="fixed inset-0 z-30 hidden bg-black/40 sm:hidden"></div>

    <div class="flex min-h-screen">
      <aside id="sidebar" class="sidebar fixed inset-y-0 left-0 z-40 w-56 -translate-x-full transition-transform duration-200 sm:sticky sm:top-0 sm:h-screen sm:translate-x-0 sm:transition-none shrink-0 border-r border-[#eaecf0] dark:border-[#262d38] p-4 flex flex-col gap-1 overflow-y-auto" style="background: var(--bg)">
        <div class="px-3 py-4 mb-2">
          <div class="font-bold tracking-tight">Instagram Monitor</div>
          <div class="text-[10px] text-[#8e8e93] uppercase tracking-wider mt-1">change monitor</div>
        </div>
        ${PAGES.map((p) => `
          <button class="nav-item ${page === p.id ? 'active' : ''}" data-page="${p.id}">
            ${p.icon} <span class="nav-label">${p.label}</span>
          </button>`).join('')}
        <div class="flex-1"></div>
        <button id="logout-btn" class="nav-item">${ICONS.logout} <span class="nav-label">Log out</span></button>
      </aside>
      <main class="flex-1 min-w-0 px-4 py-6 sm:px-6 sm:py-8 max-w-5xl">
        <div id="main"></div>
      </main>
    </div>`;

  const sidebar = $('#sidebar');
  const scrim = $('#scrim');
  const setMenuOpen = (open) => {
    sidebar.classList.toggle('-translate-x-full', !open);
    scrim.classList.toggle('hidden', !open);
    $('#menu-btn')?.setAttribute('aria-expanded', String(open));
  };

  $('#menu-btn').addEventListener('click', () => setMenuOpen(true));
  scrim.addEventListener('click', () => setMenuOpen(false));

  app.querySelectorAll('.nav-item[data-page]').forEach((btn) => {
    btn.addEventListener('click', () => {
      page = btn.dataset.page;
      
      // Update sidebar visual feedback immediately
      app.querySelectorAll('.nav-item[data-page]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      
      setMenuOpen(false);
      renderPage();
    });
  });

  $('#logout-btn').addEventListener('click', async () => {
    setMenuOpen(false);
    await api('/api/logout', { method: 'POST' });
    status.locked = true;
    render();
  });

  renderPage();
}

async function renderQuotaPage() {
  $('#main').innerHTML = `
    ${pageHeader('API Quota', 'Track your API limits and usage.')}
    <div class="card p-6 min-h-[200px] flex items-center justify-center">
      <div class="animate-pulse flex items-center gap-2"><span class="h-4 w-4 rounded-full bg-[#eaecf0] block"></span> Loading quota...</div>
    </div>`;

  try {
    const res = await fetch('/api/usage');
    if (!res.ok) throw new Error('Failed to load usage data.');
    const usage = await res.json();
    
    let html = `${pageHeader('API Quota', 'Track your API limits and usage.')}
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">`;
    
    for (const [name, p] of Object.entries(usage.providers)) {
      const isExhausted = p.usedPct >= 100;
      const barColor = isExhausted ? 'bg-[#ff5530]' : 'bg-[#1ba673]';
      html += `
        <div class="card p-5">
          <div class="flex items-center justify-between mb-4">
            <h3 class="font-bold text-lg capitalize text-[#1a1a1a] dark:text-white">${name}</h3>
            <span class="chip ${isExhausted ? 'chip-err' : 'chip-ok'}">${isExhausted ? 'Exhausted' : 'Healthy'}</span>
          </div>
          <div class="mb-2 flex justify-between text-sm">
            <span class="text-[#8e8e93]">Monthly Usage</span>
            <span class="font-medium text-[#1a1a1a] dark:text-white">${p.month.units} / ${p.monthlyCeiling || '∞'} units</span>
          </div>
          <div class="w-full bg-[#eaecf0] dark:bg-[#2a3441] rounded-full h-2 mb-4 overflow-hidden">
            <div class="${barColor} h-2 rounded-full" style="width: ${p.usedPct}%"></div>
          </div>
          <div class="grid grid-cols-2 gap-4 text-sm mt-4">
            <div>
              <div class="text-[#8e8e93] text-xs">Today</div>
              <div class="font-semibold text-[#45515e] dark:text-[#a8b3c0]">${p.day.units} / ${p.dailyLimit}</div>
            </div>
            <div>
              <div class="text-[#8e8e93] text-xs">Remaining</div>
              <div class="font-semibold text-[#45515e] dark:text-[#a8b3c0]">${p.remainingMonth}</div>
            </div>
          </div>
        </div>`;
    }
    
    html += `</div>`;
    $('#main').innerHTML = html;
  } catch (err) {
    $('#main').innerHTML = `${pageHeader('API Quota', 'Track your API limits and usage.')}
      <div class="card p-6"><div class="text-[#ff5530]">Error: ${escapeHtml(err.message)}</div></div>`;
  }
}

async function renderPage() {
  if (page === 'leaderboard') return renderLeaderboardPage();
  if (page === 'graphs') return renderGraphsPage();
  if (page === 'quota') return renderQuotaPage();
  if (page === 'config') return renderConfigPage();
  if (page === 'data') return renderDataPage();
  if (page === 'gallery') return renderGalleryPage();
  return renderDashboardPage();
}

function renderLogin() {
  app.innerHTML = `
    <div class="flex min-h-screen items-center justify-center fade-in">
      <div class="card w-full max-w-md p-8 m-4">
        <div class="mb-4"><span class="chip chip-info">locked</span></div>
        <h1 class="text-2xl font-bold">Locked</h1>
        <p class="text-[#5f5f5f] dark:text-[#a8b3c0] mt-1 text-sm">Enter your password to view the monitor.</p>
        <form id="login-form" class="mt-6 flex flex-col gap-4">
          <input class="input" id="password-input" type="password" placeholder="Password" autofocus />
          <button type="submit" class="btn-pill btn-primary">Unlock</button>
        </form>
      </div>
    </div>`;
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#password-input').value }) });
      status.locked = false;
      render();
    } catch (err) {
      showToast(err.message, false);
    }
  });
}

function renderSetup() {
  app.innerHTML = `
    <div class="flex min-h-screen items-center justify-center fade-in">
      <div class="card w-full max-w-md p-8 m-4">
        <div class="mb-4"><span class="chip chip-info">first run</span></div>
        <h1 class="text-2xl font-bold">Welcome</h1>
        <p class="text-[#5f5f5f] dark:text-[#a8b3c0] mt-1 text-sm">This monitor is password-locked. Set your password to begin.</p>
        <form id="setup-form" class="mt-6 flex flex-col gap-4">
          <input class="input" id="password-input" type="password" placeholder="Choose a password" autofocus />
          <button type="submit" class="btn-pill btn-primary">Set password</button>
        </form>
      </div>
    </div>`;
  $('#setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/setup', { method: 'POST', body: JSON.stringify({ password: $('#password-input').value }) });
      status.passwordSet = true;
      status.locked = false;
      render();
    } catch (err) {
      showToast(err.message, false);
    }
  });
}

async function refresh() {
  status = await api('/api/status');
  if (status.passwordSet && status.locked) {
    return renderLogin();
  }
  if (!status.passwordSet) {
    return renderSetup();
  }
  if (!historyData) historyData = await api('/api/history');
  renderShell();
  lastStatusKey = statusFingerprint(status);
}

async function render() {
  historyData = null;
  activeAccount = 'all';
  page = 'dashboard';
  await refresh();
}

function wireLightbox() {
  const el = document.getElementById('lightbox');
  el.querySelector('.lb-close').addEventListener('click', closeLightbox);
  el.querySelector('.lb-prev').addEventListener('click', () => moveLightbox(-1));
  el.querySelector('.lb-next').addEventListener('click', () => moveLightbox(1));
  el.addEventListener('click', (e) => {
    if (e.target === el) closeLightbox();
  });
  window.addEventListener('keydown', (e) => {
    if (el.classList.contains('show')) {
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft') moveLightbox(-1);
      if (e.key === 'ArrowRight') moveLightbox(1);
    }
  });
}

/* ---------- Live auto-refresh ---------- */

function statusFingerprint(s) {
  const profiles = (s.profiles || []).map((p) => p.username + ':' + p.lastPollAt).join(',');
  return JSON.stringify([s.lastPollAt, s.lastPollStatus, s.totalSnapshots, s.totalChanges, s.nextPollAt, profiles]);
}

function isTyping() {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA');
}

async function liveRefresh() {
  if (document.hidden || isTyping()) return;
  try {
    const s = await api('/api/status');
    if (statusFingerprint(s) === lastStatusKey) return;
    lastStatusKey = statusFingerprint(s);
    status = s;
    if (status.passwordSet && status.locked) return;
    historyData = await api('/api/history');
    renderPage();
  } catch {
    /* keep old view on transient errors */
  }
}

wireLightbox();
render();
setInterval(liveRefresh, 15000);

import crypto from 'node:crypto';
import { runActorSync } from './apify.js';

/**
 * Picks the best media URL for a story/highlight item.
 *
 * - Video stories (media_type 2 / mediaType 2 / type "video") return the first
 *   entry of `video_versions` (highest resolution).
 * - Image stories return the first entry of `image_versions2.candidates`
 *   (Instagram returns candidates highest-resolution first).
 *
 * Falls back to the common actor fields (`mediaUrl`, `displayUrl`, ...) when
 * the structured versions are missing.
 */
export function pickStoryMedia(item) {
  const numType = Number(item.media_type ?? item.mediaType);
  const isVideo =
    numType === 2 ||
    item.type === 'video' ||
    item.mediaType === 'video' ||
    (Array.isArray(item.video_versions) &&
      item.video_versions.length > 0 &&
      !(numType === 1 || item.type === 'image' || item.mediaType === 'image'));

  const candidates = Array.isArray(item.image_versions2?.candidates) ? item.image_versions2.candidates : [];
  const bestImage = candidates[0]?.url || (candidates.length > 1 ? candidates[candidates.length - 1]?.url : null);
  const bestVideo = Array.isArray(item.video_versions) && item.video_versions.length > 0 ? item.video_versions[0]?.url : null;

  return (
    (isVideo ? bestVideo : bestImage) ||
    (Array.isArray(item.media) && item.media[0]?.url) ||
    item.mediaUrl ||
    item.displayUrl ||
    item.downloadUrl ||
    item.imageUrl ||
    null
  );
}

/**
 * Stable, content-based id for a story/highlight item. The scraper returns
 * freshly time-signed CDN URLs on every run, so we must NOT key on the raw URL
 * (it would break dedup and re-notify/re-download every poll). We use the
 * highlight page id when available, otherwise the numeric media id embedded in
 * the CDN path, otherwise a hash of the path.
 */
export function stableStoryId(item, mediaUrl) {
  const page = /stories\/highlights\/(\d+)/.exec(item.url || '');
  if (page) return `hl:${page[1]}`;
  const base = (mediaUrl || '').split('?')[0].replace(/^https?:\/\//, '');
  const m = /\/(\d{6,})[_.]/.exec(base);
  if (m) return `media:${m[1]}`;
  return `m:${crypto.createHash('sha1').update(base).digest('hex').slice(0, 12)}`;
}

/**
 * Fetches current stories + highlights for a profile using the configured
 * stories actor. Returns a normalized list:
 *   [{ id, timestamp, mediaUrl, thumbnailUrl, isHighlight, highlightTitle, caption, type }]
 * Returns [] when no stories actor is configured or nothing is found.
 */
export async function fetchStories(username, config) {
  if (!config.storiesActor) return [];

  const actor = config.storiesActor;
  const input = {
    username,
    includeStories: true,
    includeHighlights: true,
    maxItems: 50,
    proxy: config.storiesProxy ? { useApifyProxy: true, apifyProxyGroups: [config.storiesProxy] } : undefined,
  };

  let raw;
  try {
    raw = await runActorSync(actor, input, config.apifyToken);
  } catch (err) {
    throw new Error(`stories: ${err.message}`);
  }

  const items = Array.isArray(raw) ? raw : [];
  const out = [];
  const seenIds = new Set();
  for (const item of items) {
    if (item.type && item.type !== 'story' && item.type !== 'highlight') continue;
    const mediaUrl = pickStoryMedia(item);
    if (!mediaUrl) continue;

    const id = stableStoryId(item, mediaUrl);
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);

    let timestamp = item.timestamp || null;
    if (typeof timestamp === 'number') timestamp = new Date(timestamp * 1000).toISOString();
    else if (!timestamp && item.taken_at) timestamp = new Date(Number(item.taken_at) * 1000).toISOString();
    else if (typeof timestamp !== 'string') timestamp = null;

    out.push({
      id,
      timestamp,
      mediaUrl,
      thumbnailUrl: item.thumbnailUrl || item.display_url || null,
      isHighlight: item.isHighlight !== undefined ? !!item.isHighlight : item.type === 'highlight',
      highlightTitle: item.highlightTitle || item.highlight_title || null,
      caption: item.caption || null,
      type: item.mediaType || item.type || null,
    });
  }
  return out;
}

/**
 * Filters out stories that have already been seen (dedupe by id and
 * timestamp). Returns only the new ones.
 */
export function filterNewStories(stories, seenStories) {
  const seen = new Set(seenStories.map((s) => s.id));
  return stories.filter((s) => !seen.has(s.id));
}

export function rememberStories(seenStories, newStories) {
  const merged = seenStories.map((s) => ({ ...s }));
  for (const s of newStories) {
    merged.push({ id: s.id, timestamp: s.timestamp || new Date().toISOString() });
  }
  return merged.slice(-200);
}

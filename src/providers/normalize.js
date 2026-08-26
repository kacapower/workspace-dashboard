/**
 * Canonical shape mapping for every non-Apify provider.
 *
 * The router treats providers as interchangeable, which only holds if they all
 * return the SAME object shape. Each vendor names fields differently
 * (`followers_count` vs `followers` vs `edge_followed_by.count`), so all of them
 * funnel through here instead of each hand-rolling its own mapping.
 *
 * Target shape matches `normalizeProfile()` in ../apify.js exactly:
 *   { username, fullName, biography, followersCount, followingCount, postsCount,
 *     externalUrl, isPrivate, verified, profilePicUrl, posts[] }
 */

/** First value that is neither undefined nor null. Preserves `0` and `false`. */
export function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return null;
}

/** Coerces to a finite number, or null. Handles "1,234" and "1.2M". */
export function toCount(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'object') return toCount(v.count);
  const s = String(v).trim().replace(/,/g, '');
  const m = /^([\d.]+)\s*([kmb])$/i.exec(s);
  if (m) {
    const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()];
    return Math.round(Number(m[1]) * mult);
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Normalizes a timestamp (unix seconds, unix ms, or ISO) to an ISO string. */
export function toIso(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') {
    // Values below ~1e12 are seconds; above are already milliseconds.
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const s = String(v);
  if (/^\d+$/.test(s)) return toIso(Number(s));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Unwraps the many envelope shapes vendors wrap a single profile in. */
export function unwrapProfile(raw) {
  let item = raw;
  if (Array.isArray(item)) item = item[0];
  if (!item || typeof item !== 'object') return null;
  // { data: {...} } / { data: { user: {...} } } / { user: {...} } / { result: {...} }
  for (const key of ['data', 'user', 'result', 'profile', 'graphql']) {
    if (item[key] && typeof item[key] === 'object' && !Array.isArray(item[key])) {
      const inner = item[key];
      // Only descend when the wrapper itself carries no profile signal.
      if (!hasProfileSignal(item) && (hasProfileSignal(inner) || inner.user)) {
        item = inner.user && !hasProfileSignal(inner) ? inner.user : inner;
      }
    }
  }
  return item;
}

const PROFILE_SIGNAL_KEYS = [
  'username', 'account', 'full_name', 'fullName', 'biography', 'bio',
  'followers_count', 'followersCount', 'followers', 'follower_count',
  'edge_followed_by', 'is_private', 'isPrivate', 'private',
  'profile_pic_url', 'profilePicUrl', 'profile_image_link', 'media_count', 'posts_count',
];

/** Whether an object looks like an Instagram profile payload at all. */
export function hasProfileSignal(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return PROFILE_SIGNAL_KEYS.some((k) => obj[k] !== undefined);
}

/**
 * Maps any vendor profile payload onto the canonical shape.
 *
 * Throws when the payload carries no recognizable profile fields. That matters:
 * a silent fallback to zeros/false would be stored as a snapshot and read as a
 * real Instagram change (account went public, lost all followers) and would fire
 * alerts. Throwing instead surfaces as ERROR_KIND.SCHEMA, which makes the router
 * fail over to the next provider — a provider fault is never a profile change.
 *
 * @param {object} raw vendor payload
 * @param {{username?: string}} opts fallback username when the payload omits it
 */
export function normalizeProfileShape(raw, { username = null } = {}) {
  const item = unwrapProfile(raw);
  if (!hasProfileSignal(item)) {
    throw new Error(`unexpected response: no recognizable profile fields${username ? ` for "${username}"` : ''}`);
  }

  const resolved = firstDefined(item.username, item.account, item.user_name, item.handle, username);

  return {
    username: resolved ? String(resolved).replace(/^@/, '') : null,
    fullName: firstDefined(item.full_name, item.fullName, item.name, item.display_name),
    biography: firstDefined(item.biography, item.bio, item.description),
    followersCount: toCount(firstDefined(item.followers_count, item.followersCount, item.follower_count, item.followers, item.edge_followed_by)),
    followingCount: toCount(firstDefined(item.following_count, item.followingCount, item.follows_count, item.followsCount, item.following, item.edge_follow)),
    postsCount: toCount(firstDefined(item.posts_count, item.postsCount, item.media_count, item.mediaCount, item.edge_owner_to_timeline_media, typeof item.posts === 'number' ? item.posts : undefined)),
    externalUrl: firstDefined(item.external_url, item.externalUrl, item.website, item.bio_links?.[0]?.url),
    isPrivate: !!firstDefined(item.is_private, item.isPrivate, item.private, false),
    verified: !!firstDefined(item.is_verified, item.isVerified, item.verified, false),
    profilePicUrl: firstDefined(
      item.profile_pic_url_hd, item.profilePicUrlHD, item.profile_pic_url_HD,
      item.profile_pic_url, item.profilePicUrl, item.profile_image_link,
      item.profile_picture, item.profilePic, item.avatar, item.avatar_url
    ),
    posts: normalizePosts(firstDefined(item.latestPosts, item.posts, item.recent_posts, item.media, item.items, item.edge_owner_to_timeline_media?.edges)),
  };
}

/** Maps a vendor post list onto the canonical post shape. */
export function normalizePosts(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => {
      // GraphQL-style lists wrap each item in { node: {...} }.
      const p = entry?.node || entry;
      if (!p || typeof p !== 'object') return null;

      const shortcode = firstDefined(p.shortcode, p.short_code, p.code);
      const displayUrl = firstDefined(
        p.displayUrl, p.display_url, p.imageUrl, p.image_url, p.thumbnail_src,
        p.media_url, p.url, Array.isArray(p.images) ? p.images[0] : undefined,
        p.image_versions2?.candidates?.[0]?.url
      );
      const timestamp = toIso(firstDefined(p.timestamp, p.taken_at, p.taken_at_timestamp, p.created_at, p.date));
      const id = firstDefined(p.id, p.pk, shortcode, timestamp && displayUrl ? `${timestamp}-${displayUrl}` : undefined);
      if (!id) return null;

      const caption = typeof p.caption === 'string'
        ? p.caption
        : firstDefined(p.caption?.text, p.caption_text, p.edge_media_to_caption?.edges?.[0]?.node?.text, p.description);

      return {
        id: String(id),
        shortcode: shortcode ? String(shortcode) : null,
        timestamp,
        caption: caption ?? null,
        likesCount: toCount(firstDefined(p.likesCount, p.like_count, p.likes_count, p.likes, p.edge_liked_by, p.edge_media_preview_like)),
        commentsCount: toCount(firstDefined(p.commentsCount, p.comment_count, p.comments_count, p.comments, p.edge_media_to_comment)),
        displayUrl: displayUrl ?? null,
        thumbnailUrl: firstDefined(p.thumbnailUrl, p.thumbnail_url, p.thumbnail_src, p.thumb),
        isVideo: !!firstDefined(p.isVideo, p.is_video, p.videoUrl, p.video_url, Number(p.media_type) === 2 || undefined, false),
      };
    })
    .filter(Boolean);
}

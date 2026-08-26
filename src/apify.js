const APIFY_API = 'https://api.apify.com/v2';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs an Apify actor with a synchronous run and returns the first dataset item.
 * POST /v2/acts/{actor}/run-sync-get-dataset-items?token=...&timeout=240
 */
export async function runActorSync(actor, input, token, { timeoutMs = 240000 } = {}) {
  if (!token) {
    throw new Error('APIFY_TOKEN is not set. Add it to your .env or environment variables.');
  }
  const tokens = token.split(',').map((t) => t.trim()).filter(Boolean);
  let lastErr;
  let res;
  let text;
  
  for (const currentToken of tokens) {
    try {
      const url = `${APIFY_API}/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items?token=${encodeURIComponent(currentToken)}&timeout=${timeoutMs / 1000}`;
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      text = await res.text();
      
      if (!res.ok) {
        const err = new Error(`Apify request failed (${res.status}): ${text}`);
        err.status = res.status;
        lastErr = err;
        
        // If it's a quota (402), auth (403), or rate limit (429) error, try the next token
        if (res.status === 402 || res.status === 403 || res.status === 429) {
          console.warn(`[apify] Token exhausted or rate limited (HTTP ${res.status}), trying next token if available...`);
          continue;
        }
        throw err;
      }
      
      // Success!
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (err.status) throw err; // Only catch network errors, not non-auth API errors
    }
  }

  if (lastErr) throw lastErr;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Apify returned an unexpected response: ${text.slice(0, 500)}`);
  }
  return body;
}

/**
 * Normalizes an Apify Instagram profile item into our snapshot profile shape.
 * Adapts to the official apify/instagram-scraper output and common community
 * actor variants (apidojo/instagram-scraper, prodiger/instagram-scraper).
 */
export function normalizeProfile(raw) {
  const item = Array.isArray(raw) ? raw[0] : raw;
  if (!item || item.noResults) {
    throw new Error('Instagram returned no profile data. The account may be private or the username may be wrong.');
  }

  const recentPosts = Array.isArray(item.latestPosts)
    ? item.latestPosts
    : Array.isArray(item.posts)
      ? item.posts
      : [];

  const posts = recentPosts.map((p) => ({
    id: String(p.id || p.shortcode || `${p.timestamp}-${p.displayUrl}`),
    shortcode: p.shortcode || null,
    timestamp: p.timestamp || null,
    caption: typeof p.caption === 'string' ? p.caption : p.caption?.text || null,
    likesCount: p.likesCount ?? p.likes ?? null,
    commentsCount: p.commentsCount ?? p.comments ?? null,
    displayUrl: p.displayUrl || p.imageUrl || p.url || p.images?.[0] || null,
    thumbnailUrl: p.thumbnailUrl || p.thumb || null,
    isVideo: !!p.videoUrl || !!p.isVideo,
  }));

  return {
    username: item.username,
    fullName: item.fullName ?? item.name ?? null,
    biography: item.biography ?? item.bio ?? null,
    followersCount: item.followersCount ?? item.followers ?? null,
    followingCount: item.followsCount ?? item.followingCount ?? null,
    postsCount: item.postsCount ?? null,
    externalUrl: item.externalUrl ?? item.website ?? null,
    isPrivate: !!item.private || !!item.isPrivate,
    verified: !!item.verified,
    profilePicUrl: item.profilePicUrlHD || item.profilePicUrl || item.profilePic || null,
    posts,
  };
}

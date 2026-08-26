/**
 * Shared HTTP transport for providers.
 *
 * Every provider needs the same three things: a hard timeout, a `status`
 * property on failures (so `toProviderError` can classify 429 → rate_limit,
 * 401/403 → auth, 5xx → network instead of string-matching a message), and
 * JSON parsing that fails loudly rather than returning undefined.
 */

/** Thrown with `status` attached so provider-interface.js can classify it. */
function httpError(message, status, bodyText) {
  const err = new Error(bodyText ? `${message}: ${bodyText.slice(0, 300)}` : message);
  err.status = status;
  return err;
}

/**
 * Performs a request and returns `{ status, headers, text }` without throwing on
 * a non-2xx — callers that treat specific codes as control flow (Bright Data's
 * 202 "still running", for example) need the status, not an exception.
 */
export async function fetchRaw(url, { method = 'GET', headers = {}, body = null, timeoutMs = 60000 } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // AbortSignal.timeout produces a TimeoutError; normalize the message so the
    // error taxonomy maps it to ERROR_KIND.TIMEOUT.
    const isAbort = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw httpError(isAbort ? `request timed out after ${timeoutMs}ms` : `fetch failed: ${err?.message || err}`, null);
  }
  return { status: res.status, ok: res.ok, headers: res.headers, text: await res.text() };
}

/** As `fetchRaw`, but throws on non-2xx and returns parsed JSON. */
export async function fetchJson(url, opts = {}) {
  const { status, ok, text } = await fetchRaw(url, opts);
  if (!ok) throw httpError(`request failed (${status})`, status, text);
  return parseJson(text, status);
}

export function parseJson(text, status = null) {
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw httpError(`invalid json in response`, status, text);
  }
}

/** Builds a query string from defined values only. */
export function qs(params = {}) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

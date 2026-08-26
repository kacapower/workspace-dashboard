/**
 * Minimal Supabase REST client (PostgREST + Storage).
 *
 * WHY NOT @supabase/supabase-js: this file has to run unchanged in three
 * runtimes — Node (Vercel functions, CLI), Deno (the Edge Function) and
 * `node --test`. A dependency-free `fetch` wrapper keeps the Edge Function
 * bundle to our own source and avoids a second import map. Only table CRUD,
 * RPC and Storage are needed, and each is one request.
 *
 * The service-role key bypasses RLS, so this must NEVER be constructed with a
 * key that can reach the browser.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

/** Storage keys are path-shaped; each segment must be encoded separately. */
function encodeObjectPath(p) {
  return String(p)
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
}

export class SupabaseRest {
  constructor({ url, serviceKey, bucket = 'media', fetcher = fetch, timeoutMs = 20000 } = {}) {
    if (!url) throw new Error('SUPABASE_URL is required');
    if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');
    this.url = String(url).replace(/\/+$/, '');
    this.key = serviceKey;
    this.bucket = bucket;
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
  }

  async _request(pathname, { method = 'GET', headers = {}, body = null, raw = false, allow404 = false } = {}) {
    const res = await this.fetcher(`${this.url}${pathname}`, {
      method,
      headers: { apikey: this.key, Authorization: `Bearer ${this.key}`, ...headers },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      if (allow404 && res.status === 404) return null;
      const text = await res.text().catch(() => '');
      const err = new Error(`supabase ${method} ${pathname} -> ${res.status} ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    if (raw) return res;
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  /* ---- tables ---- */

  select(table, query = '') {
    return this._request(`/rest/v1/${table}${query ? `?${query}` : ''}`, { headers: { Accept: 'application/json' } });
  }

  insert(table, rows, { returning = 'minimal' } = {}) {
    return this._request(`/rest/v1/${table}`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, Prefer: `return=${returning}` },
      body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
    });
  }

  upsert(table, rows, { onConflict = null, returning = 'minimal' } = {}) {
    const q = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
    return this._request(`/rest/v1/${table}${q}`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, Prefer: `resolution=merge-duplicates,return=${returning}` },
      body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
    });
  }

  patch(table, query, values, { returning = 'minimal' } = {}) {
    return this._request(`/rest/v1/${table}?${query}`, {
      method: 'PATCH',
      headers: { ...JSON_HEADERS, Prefer: `return=${returning}` },
      body: JSON.stringify(values),
    });
  }

  remove(table, query) {
    return this._request(`/rest/v1/${table}?${query}`, { method: 'DELETE', headers: JSON_HEADERS });
  }

  rpc(fn, args = {}) {
    return this._request(`/rest/v1/rpc/${fn}`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(args) });
  }

  /* ---- storage ---- */

  async putObject(objectPath, bytes, { contentType = 'application/octet-stream', upsert = true } = {}) {
    await this._request(`/storage/v1/object/${this.bucket}/${encodeObjectPath(objectPath)}`, {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'x-upsert': String(upsert) },
      body: bytes,
      raw: true,
    });
    return objectPath;
  }

  async getObject(objectPath) {
    const res = await this._request(`/storage/v1/object/${this.bucket}/${encodeObjectPath(objectPath)}`, {
      raw: true,
      allow404: true,
    });
    if (!res) return null;
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * Storage list is paginated at 100 by default and silently truncates, which
   * would make retention think there is nothing left to prune. Page explicitly.
   */
  async listObjects(prefix = '', { pageSize = 1000 } = {}) {
    const out = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = await this._request(`/storage/v1/object/list/${this.bucket}`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ prefix, limit: pageSize, offset, sortBy: { column: 'name', order: 'asc' } }),
      });
      if (!Array.isArray(page) || page.length === 0) break;
      out.push(...page);
      if (page.length < pageSize) break;
    }
    return out;
  }

  removeObjects(paths) {
    const prefixes = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
    if (!prefixes.length) return Promise.resolve([]);
    return this._request(`/storage/v1/object/${this.bucket}`, {
      method: 'DELETE',
      headers: JSON_HEADERS,
      body: JSON.stringify({ prefixes }),
    });
  }

  moveObject(from, to) {
    return this._request('/storage/v1/object/move', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ bucketId: this.bucket, sourceKey: from, destinationKey: to }),
    });
  }

  async signObject(objectPath, expiresIn = 3600) {
    const r = await this._request(`/storage/v1/object/sign/${this.bucket}/${encodeObjectPath(objectPath)}`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ expiresIn }),
    });
    // signedURL comes back relative to /storage/v1.
    return r?.signedURL ? `${this.url}/storage/v1${r.signedURL.replace(/^\/?/, '/')}` : null;
  }

  /** Idempotent: the bucket is private, so media is only reachable via our API. */
  async ensureBucket() {
    try {
      await this._request('/storage/v1/bucket', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id: this.bucket, name: this.bucket, public: false }),
      });
      return { created: true };
    } catch (err) {
      if (err.status === 409) return { created: false };
      throw err;
    }
  }
}

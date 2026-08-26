import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { SupabaseStore } from '../src/stores/supabase-store.js';

/**
 * Vercel entry point — ONE catch-all function.
 *
 * `createApp()` already builds the whole Express app, so mounting it here ports
 * all 24 routes at once instead of rewriting each as its own handler. That also
 * keeps the deployment to a single function, well under Vercel Hobby's limit of
 * twelve.
 *
 * Static `public/` assets are served by Vercel's CDN, not by this function; only
 * /api/* is rewritten here (see vercel.json).
 */
let booted = null;

function boot() {
  if (booted) return booted;
  const config = loadConfig();
  const useSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  const store = useSupabase
    ? new SupabaseStore({
        url: process.env.SUPABASE_URL,
        serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        bucket: process.env.SUPABASE_BUCKET || 'media',
      })
    : new Store(config.dataDir);
  booted = { config, store, app: createApp({ config, store }), useSupabase };
  return booted;
}

/**
 * Requests are serialised through this chain. `readJson`/`writeJson` are
 * synchronous over one in-memory document map, so two concurrent invocations
 * sharing a warm instance could otherwise flush each other's half-applied state.
 */
let chain = Promise.resolve();

function serialise(fn) {
  const next = chain.then(fn, fn);
  // Keep the chain alive after a rejection, and never let it retain results.
  chain = next.then(
    () => {},
    () => {}
  );
  return next;
}

export default async function handler(req, res) {
  const { store, app } = boot();

  return serialise(async () => {
    // No-op on the filesystem store; one request on Supabase. A serverless
    // instance cannot cache this across invocations — another instance or the
    // Edge Function may have written in between.
    await store.hydrate();

    const done = new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      res.on('finish', finish);
      res.on('close', finish);
    });

    app(req, res);
    await done;

    try {
      await store.flush();
    } catch (err) {
      console.error(`[vercel] flush failed: ${err.message}`);
    }
  });
}

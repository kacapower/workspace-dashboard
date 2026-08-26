import { FsStore } from './stores/fs-store.js';

/**
 * `Store` stays the name of the local-filesystem implementation so the server,
 * the CLI poller and all existing tests import it unchanged. The Supabase
 * backend is a sibling in `./stores/` and is chosen explicitly by the Edge
 * Function / Vercel entry points, never by autodetection — a misconfigured
 * environment must fail loudly rather than silently write to the wrong place.
 */
export { FsStore, FsStore as Store };
export { BaseStore } from './stores/base-store.js';

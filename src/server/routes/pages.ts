/**
 * Friendly page routes → files under public/. Every other static file is resolved by
 * `src/server/static.ts` (allowlisted extensions, traversal-safe).
 */
export const PAGE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  '/': 'control/index.html',
  '/control': 'control/index.html',
  '/overlay/a': 'overlay/index.html',
  '/overlay/b': 'overlay/index.html',
  '/dev': 'dev/index.html',
});

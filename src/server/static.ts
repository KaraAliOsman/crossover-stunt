import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { PAGE_ALIASES } from './routes/pages.js';

/** Extension allowlist (docs/DESIGN.md §Server). Anything else under public/ is never served. */
export const STATIC_CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
});

export interface StaticFile {
  readonly body: Buffer;
  readonly contentType: string;
}

/**
 * Pure mapping from a URL pathname (as produced by `new URL()`, i.e. still percent-encoded) to a
 * POSIX-style path relative to public/, or null when it must not be served.
 * Decodes exactly once, then rejects traversal (`..`, `.`), empty segments, dotfiles,
 * backslashes, NUL, drive letters / NTFS streams (`:`) and non-allowlisted extensions.
 */
export function toPublicRelativePath(pathname: string): string | null {
  const alias = PAGE_ALIASES[pathname];
  if (alias !== undefined) return alias;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/') || decoded.length > 512) return null;
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const segments = decoded.slice(1).split('/');
  const unsafe = segments.some(
    (segment) => segment === '' || segment.startsWith('.') || segment.includes(':'),
  );
  if (unsafe) return null;
  const extension = path.posix.extname(decoded).toLowerCase();
  if (!Object.hasOwn(STATIC_CONTENT_TYPES, extension)) return null;
  return segments.join('/');
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Safe file reader rooted at `root`. Besides the pure path checks it verifies, after resolving
 * symlinks, that the real file is still inside the real root and is a regular file.
 */
export function createStaticResolver(
  root: string,
): (pathname: string) => Promise<StaticFile | null> {
  const rootPath = path.resolve(root);
  let realRoot: string | null = null;
  return async (pathname) => {
    const relative = toPublicRelativePath(pathname);
    if (relative === null) return null;
    const absolute = path.resolve(rootPath, ...relative.split('/'));
    if (!isInside(rootPath, absolute)) return null;
    try {
      realRoot ??= await realpath(rootPath);
      const resolvedFile = await realpath(absolute);
      if (!isInside(realRoot, resolvedFile)) return null;
      if (!(await stat(resolvedFile)).isFile()) return null;
      const contentType = STATIC_CONTENT_TYPES[path.extname(resolvedFile).toLowerCase()];
      if (contentType === undefined) return null;
      return { body: await readFile(resolvedFile), contentType };
    } catch {
      // Missing file or permission problem: an indistinguishable 404 for clients.
      return null;
    }
  };
}

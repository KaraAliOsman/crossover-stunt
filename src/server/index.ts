import path from 'node:path';
import { MISSING_CLIENT_ID_ERROR, createApp } from './http.js';

const args = new Set(process.argv.slice(2));
const demo = args.has('--demo');
const autoplay = args.has('--autoplay');
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
  throw new Error('PORT must be 0..65535');
// Loopback only: remote partners reach overlay B through the room-token tunnel (pnpm share).
if (host !== '127.0.0.1' && host !== 'localhost') {
  throw new Error('HOST must be 127.0.0.1 or localhost; use the share tunnel for a remote partner');
}
if (autoplay && !demo) console.warn('--autoplay only applies to pnpm demo; ignoring it.');

const clientId = process.env.TWITCH_CLIENT_ID?.trim() ?? '';
const app = createApp({
  demo,
  autoplay: demo && autoplay,
  twitchClientId: demo ? null : clientId,
  dataDir: path.resolve('data'),
  ignoredChatters: process.env.IGNORED_CHATTERS?.split(',') ?? [],
});
let actualPort: number;
try {
  actualPort = await app.listen(port, host);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
  console.error(
    `Port ${port} on ${host} is already in use (another Crossover Stunt or dev server?).
` +
      'Stop it, or pick another port: PowerShell  $env:PORT=3001  then run the same pnpm command ' +
      'again (or set PORT=3001 in .env), and use that port in the overlay/control URLs.',
  );
  await app.close();
  process.exit(1);
}
const base = `http://${host}:${actualPort}`;

console.log(
  demo
    ? 'Crossover Stunt — DEMO: SIMULATED crowd, no Twitch connection, nothing is sent to chat'
    : 'Crossover Stunt — LIVE (Twitch)',
);
const pages = demo
  ? ['/control', '/overlay/a', '/overlay/b', '/dev', '/api/health']
  : ['/control', '/overlay/a', '/overlay/b', '/api/health'];
for (const page of pages) console.log(`  ${base}${page}`);
if (demo && autoplay) console.log('Autoplay: crossover → so-close → single, looping (SIMULATED).');
if (!demo && clientId.length === 0) console.warn(MISSING_CLIENT_ID_ERROR);
// node --watch marks its child with WATCH_REPORT_DEPENDENCIES (pnpm dev).
if (!demo && process.env.WATCH_REPORT_DEPENDENCIES !== undefined) {
  console.warn(
    'Watch mode: saving any file under src/ or .env restarts the server, which loses the round, ' +
      'channel B and the partner link (new room token and tunnel URL). ' +
      'For a live session use pnpm build, then pnpm start.',
  );
}
console.log('Press Ctrl+C to stop.');

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    await app.close();
  } finally {
    // Twitch sockets or a tunnel child must not keep the process alive after Ctrl+C.
    process.exit(0);
  }
}
process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});

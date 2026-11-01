// `pnpm share` — asks the RUNNING local server (pnpm dev / pnpm start / pnpm demo) to open a
// cloudflared quick tunnel and prints the partner's read-only overlay B URL.
// `pnpm share --stop` closes the tunnel. The server owns the cloudflared child process; only
// /overlay/b, its assets, /api/snapshot and /ws?side=B are reachable through it, and only with
// the room token. The room token is not a Twitch credential.

const port = Number(process.env.PORT ?? 3000);
const base = `http://127.0.0.1:${port}`;
const POLL_MS = 500;
const TIMEOUT_MS = 45_000;

function post(path) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
}

function printInstallHint() {
  console.error(`Install cloudflared (no account needed for quick tunnels, e.g. PowerShell:
winget install Cloudflare.cloudflared), then restart the server from a NEW terminal so it sees
the updated PATH, and run pnpm share again:
  https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/`);
}

async function main() {
  try {
    await fetch(`${base}/api/health`);
  } catch {
    console.error(`No Crossover Stunt server on ${base}.
Start it first (pnpm start, pnpm dev or pnpm demo; set PORT in .env or the shell if you changed it), then run pnpm share.`);
    process.exitCode = 1;
    return;
  }

  if (process.argv.includes('--stop')) {
    await post('/api/share/stop');
    console.log('Tunnel stopped.');
    return;
  }

  const started = await post('/api/share/start');
  const body = await started.json();
  if (body.status === 'error') {
    console.error(`Share failed: ${body.error}`);
    if (body.error === 'cloudflared not installed') printInstallHint();
    process.exitCode = 1;
    return;
  }

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await (await fetch(`${base}/api/state`)).json();
    if (state.share.status === 'on' && state.overlayUrls.partnerB) {
      console.log(`Partner overlay B (send this link to your partner as an OBS browser source).
It carries the read-only room token for this server run only:
  ${state.overlayUrls.partnerB}
Quick tunnels are temporary; the link dies when the server or tunnel stops (pnpm share --stop).`);
      return;
    }
    if (state.share.status === 'error' || state.share.status === 'off') {
      console.error(`Share failed: ${state.share.error ?? 'tunnel stopped'}`);
      process.exitCode = 1;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  console.error('Timed out waiting for the tunnel URL; check the control panel.');
  process.exitCode = 1;
}

await main();

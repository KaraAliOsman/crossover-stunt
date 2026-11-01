import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const result = spawnSync(
  process.execPath,
  [require.resolve('@playwright/test/cli'), ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: fileURLToPath(new URL('../.cache/ms-playwright', import.meta.url)),
    },
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

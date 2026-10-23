import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildLaunchRecord } from './launchRecord.js';

// Stand-in for the agent CLI in KARST_FAKE_CORE=launch. Invoked as
//   node stubAgent.js <provider> <envKeys,csv> -- <the real adapter's argv...>
// Records the launch (never env values), then idles like FakeAdapter.
const [provider = 'unknown', keys = '', , ...argv] = process.argv.slice(2);
const dir = process.env['KARST_UAT_LAUNCH_DIR'];
if (dir) {
  const record = buildLaunchRecord({
    provider,
    argv,
    envKeys: keys === '' ? [] : keys.split(','),
    cwd: process.cwd(),
    readFile: (p) => { try { return readFileSync(p); } catch { return undefined; } },
  });
  appendFileSync(join(dir, 'launches.ndjson'), `${JSON.stringify(record)}\n`);
}
setTimeout(() => {}, 1000);

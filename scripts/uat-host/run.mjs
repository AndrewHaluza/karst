import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const FIXTURES = ['empty', 'ticket-mid-stage', 'blocked'];
const version = process.env.UAT_VSCODE_VERSION ?? '1.126.0';
const cachePath = resolve(process.env.UAT_VSCODE_CACHE ?? join(repoRoot, '.vscode-test'));

const i = process.argv.indexOf('--fixture');
const fixture = i >= 0 ? process.argv[i + 1] : undefined;
if (!fixture || !FIXTURES.includes(fixture)) {
  console.error(`usage: run.mjs --fixture <${FIXTURES.join('|')}>`);
  process.exit(2);
}

const { downloadAndUnzipVSCode, runTests } = await import('@vscode/test-electron');

const root = mkdtempSync(join(tmpdir(), 'karst-uat-host-'));
let code = 1;
try {
  const userData = join(root, 'user-data');
  const extensionsDir = join(root, 'extensions');
  const dbPath = join(userData, 'User', 'globalStorage', 'karst.karst', 'karst.db');
  mkdirSync(join(userData, 'User'), { recursive: true });
  mkdirSync(extensionsDir, { recursive: true });
  copyFileSync(join(here, 'settings.json'), join(userData, 'User', 'settings.json'));

  const vscodeExecutablePath = await downloadAndUnzipVSCode({ version, cachePath });

  // Seed under the VS Code binary as plain Node so better-sqlite3 loads at the
  // Electron ABI the extension host will use (arch:ABI-01).
  const prep = spawnSync(
    vscodeExecutablePath,
    [join(repoRoot, 'dist', 'uat-host', 'prepare.js'), '--fixture', fixture, '--root', join(root, 'fixture'), '--db', dbPath],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' },
  );
  if (prep.status !== 0) throw new Error(`prepare failed (${prep.status}): ${prep.stderr}`);
  const { workspaceDir, tickets } = JSON.parse(prep.stdout.trim().split('\n').pop());

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: repoRoot,
    extensionTestsPath: join(here, 'testRunner.cjs'),
    extensionTestsEnv: {
      KARST_FAKE_CORE: '1',
      UAT_EXPECT_TICKETS: String(tickets),
      UAT_DB_PATH: dbPath,
    },
    launchArgs: [
      workspaceDir,
      '--user-data-dir', userData,
      '--extensions-dir', extensionsDir,
      '--disable-extensions',
      '--disable-workspace-trust',
      '--no-sandbox',
      '--disable-gpu',
    ],
  });
  code = 0;
} catch (err) {
  console.error('uat-host: FAILED —', err instanceof Error ? err.message : err);
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(code);

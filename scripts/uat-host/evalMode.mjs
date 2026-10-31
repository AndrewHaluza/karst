import { spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * Eval mode: a REAL agent core on a REAL task repo inside the UAT container.
 * Everything here is data-in / data-out so it is unit-testable without Docker.
 * Credential VALUES are never read into a recorded structure (arch:DBG-03):
 * only env-var NAMES and the presence of an auth dir are ever reported.
 */

/** Hosts a run may reach: package registries plus each core's own API host. git hosts stay blocked. */
export const REGISTRY_HOSTS = ['registry.npmjs.org', 'registry.yarnpkg.com'];

export const EVAL_CORES = {
  claude: { bin: 'claude', authEnv: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'], apiHosts: ['api.anthropic.com'], authDir: '.claude' },
  codex: { bin: 'codex', authEnv: ['OPENAI_API_KEY'], apiHosts: ['api.openai.com'], authDir: '.codex' },
};

/** Where the eval image installs the pinned CLIs, and where the task repo is mounted. */
export const EVAL_BIN_DIR = '/opt/karst-eval/bin';
export const TASK_MOUNT = '/task';
/** Read-only auth dir mount point inside the container (alternative to env credentials). */
export const AUTH_MOUNT = '/auth';

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

export function evalCore(name) {
  const core = EVAL_CORES[name];
  if (!core) throw new Error(`uat-host eval: unknown core "${name}" (known: ${Object.keys(EVAL_CORES).join(', ')})`);
  return core;
}

/** Hosts the network rule must allow for this core. */
export function allowedHosts(coreName) {
  return [...REGISTRY_HOSTS, ...evalCore(coreName).apiHosts];
}

/** Validates an allowlist of env-var NAMES (never values) to pass with `-e NAME`. */
export function credentialNames(extra) {
  for (const n of extra) {
    if (!ENV_NAME.test(n)) throw new Error(`uat-host eval: "${n}" is not an env-var name (values must never be passed on the command line)`);
  }
  return [...new Set(extra)];
}

/** `-e NAME` pairs: Docker copies the value from the host env, so it never appears in argv. */
export function dockerCredentialArgs(names) {
  return names.flatMap((n) => ['-e', n]);
}

function isExecutable(p) {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Locate `bin` on `pathValue` (no shell). */
export function findOnPath(bin, pathValue) {
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    const p = join(dir, bin);
    if (isExecutable(p)) return p;
  }
  return null;
}

/** Runs `<bin> --version` and returns the trimmed first line; never throws. */
export function probeVersion(binPath) {
  const r = spawnSync(binPath, ['--version'], { encoding: 'utf8', timeout: 15_000 });
  if (r.status !== 0) return null;
  const line = (r.stdout || '').trim().split('\n')[0];
  return line === '' ? null : line.slice(0, 200);
}

/**
 * Fail-fast preflight. Throws one clear error naming what is missing; on success returns the
 * run record `{ core, version, authVia }` where authVia lists env NAMES or the auth-dir flag only.
 */
export function preflightEval({ core, env, binDir = EVAL_BIN_DIR, authDir, probe = probeVersion }) {
  const spec = evalCore(core);
  const bin = findOnPath(spec.bin, `${binDir}${delimiter}${env.PATH ?? ''}`);
  if (!bin) throw new Error(`uat-host eval: preflight failed — "${spec.bin}" is not installed (looked in ${binDir} and PATH)`);
  const version = probe(bin);
  if (!version) throw new Error(`uat-host eval: preflight failed — "${spec.bin} --version" did not succeed`);
  const envNames = spec.authEnv.filter((n) => (env[n] ?? '') !== '');
  const hasAuthDir = Boolean(authDir) && isDirectory(authDir);
  if (envNames.length === 0 && !hasAuthDir) {
    throw new Error(
      `uat-host eval: preflight failed — no credentials for "${core}": set one of ${spec.authEnv.join(', ')} ` +
        `(passed with --eval-env NAME) or mount an auth dir read-only with --eval-auth-dir`,
    );
  }
  return { core, version, authVia: { envNames, authDir: hasAuthDir } };
}

function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * extensionTestsEnv additions for eval mode. KARST_FAKE_CORE is left empty so `resolveAdapter`
 * returns the real adapter (it only fakes on '1'); PATH puts the pinned CLIs first and
 * VSCODE_CLI=1 stops VS Code re-resolving PATH from a login shell and dropping them.
 */
export function evalTestsEnv({ binDir = EVAL_BIN_DIR, pathValue, proxyUrl }) {
  return {
    KARST_FAKE_CORE: '',
    PATH: `${binDir}${delimiter}${pathValue}`,
    VSCODE_CLI: '1',
    ...(proxyUrl ? { HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, NO_PROXY: '127.0.0.1,localhost' } : {}),
  };
}

/** Result written next to the evidence: core name + version, credential NAMES only, and the network verdict. */
export function runRecord(preflight, network) {
  return JSON.stringify({ core: preflight.core, version: preflight.version, authVia: preflight.authVia, network }, null, 2);
}

export function readNetworkStatus(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { enforced: false, knownLeak: 'network status file missing; egress was not verified' };
  }
}

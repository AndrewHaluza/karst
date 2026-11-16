// Pure planning for serve.mjs (arch:UATHOST-08): arguments, the container name, the `docker run` argv, `docker port` output.
import { createHash } from 'node:crypto';
import { posix, relative, sep } from 'node:path';
import { resolveInsideCheckout } from './args.mjs';
import { SERVE_CONTAINER_PORT, SERVE_FIXTURES } from './serveApi.mjs';

export const SERVE_IMAGE = 'karst-uat-host:local';
export const SERVE_DOCKERFILE = 'docker/uat-host/Dockerfile';
export const PASS_ENV = ['KARST_INSTANCE_TOKEN', 'UAT_PROBE_TOTAL_MS', 'UAT_PROBE_MAX_STEP_MS', 'UAT_SERVE_BOOT_MS'];
const DEFAULT_FIXTURE = 'ticket-mid-stage';
const CONTAINER_WORK = '/work';
const USAGE = `usage: serve.mjs --port <1..65535> [--fixture <${SERVE_FIXTURES.join('|')}> | --fixture-file <path>]\n       serve.mjs --reset [--fixture <name> | --fixture-file <path>]`;

/** First 12 hex characters of sha256 of the checkout real path: one container for each worktree. */
export function checkoutKey(realRoot) {
  return createHash('sha256').update(realRoot).digest('hex').slice(0, 12);
}

export function serveContainerName(realRoot) {
  return `karst-uat-serve-${checkoutKey(realRoot)}`;
}

const usage = () => new Error(USAGE);

/** `{ mode: 'serve', port, fixture | fixtureFile }` or `{ mode: 'reset', body }`. Throws `usage:` text, or the containment error. */
export function parseServeArgs(argv, checkoutRoot) {
  const known = new Set(['--port', '--fixture', '--fixture-file', '--reset']);
  const flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!known.has(arg)) throw usage();
    if (arg === '--reset') {
      flags.set(arg, true);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw usage();
    flags.set(arg, value);
    i++;
  }
  const fixture = flags.get('--fixture');
  const fixtureFile = flags.get('--fixture-file');
  if (fixture !== undefined && fixtureFile !== undefined) throw usage();
  if (fixture !== undefined && !SERVE_FIXTURES.includes(fixture)) throw usage();
  const abs = fixtureFile === undefined ? undefined : resolveInsideCheckout(fixtureFile, checkoutRoot);
  if (flags.has('--reset')) {
    if (flags.has('--port')) throw usage();
    if (fixture !== undefined) return { mode: 'reset', body: { fixture } };
    if (abs !== undefined) return { mode: 'reset', body: { fixtureFile: posix.join(CONTAINER_WORK, relative(checkoutRoot, abs).split(sep).join('/')) } };
    return { mode: 'reset', body: {} };
  }
  const rawPort = flags.get('--port');
  if (rawPort === undefined || !/^\d+$/.test(rawPort)) throw usage();
  const port = Number(rawPort);
  if (port < 1 || port > 65535) throw usage();
  if (abs !== undefined) return { mode: 'serve', port, fixtureFile: relative(checkoutRoot, abs).split(sep).join('/') };
  return { mode: 'serve', port, fixture: fixture ?? DEFAULT_FIXTURE };
}

/** Supervisor flags for a spec; a fixture file is a path inside the container mount. */
export function fixtureArgsFor(spec) {
  if (spec.fixtureFile !== undefined) return ['--fixture-file', posix.join(CONTAINER_WORK, spec.fixtureFile)];
  return ['--fixture', spec.fixture];
}

/** The `docker run` argv. Env values never appear: only the names in PASS_ENV go in as `-e NAME`. */
export function serveDockerArgs({ name, cidfile, key, port, uid, gid, root, fixtureArgs, env }) {
  return [
    'run', '--rm', '--init', '-i', '--name', name, '--cidfile', cidfile, '--label', `karst.uat.serve=${key}`,
    '-p', `127.0.0.1:${port}:${SERVE_CONTAINER_PORT}`,
    '-e', `HOST_UID=${uid}`, '-e', `HOST_GID=${gid}`, '-e', `UAT_SERVE_HOST_PORT=${port}`,
    ...PASS_ENV.filter((n) => env[n] !== undefined).flatMap((n) => ['-e', n]),
    '-v', `${root}:${CONTAINER_WORK}`, '-v', 'karst-uat-vscode:/vscode-cache',
    '--entrypoint', 'bash', SERVE_IMAGE, '/usr/local/bin/uat-serve-entrypoint.sh', ...fixtureArgs,
  ];
}

/** The host port of the first `docker port` line, or null. */
export function parseDockerPort(output) {
  const first = output.split('\n').find((l) => l.trim() !== '');
  const m = first && /:(\d+)\s*$/.exec(first.trim());
  return m ? Number(m[1]) : null;
}

import type { RemoteDef } from '../../manifest/types.js';
import { sshArgv, type SshProcess, type SshResult } from './sshProcess.js';
import { sshQuote } from './sshQuote.js';

/**
 * The remote env files of `mode: docker` (D822, edits 8 and 13).
 *
 * The docker CLIENT reads `--env-file`, and in this mode the client runs on the
 * REMOTE host over ssh. Both the interactive session
 * (`<ws>/env/docker.env`) and a UAT service (`<ws>/env/svc-<key>.env`) are
 * therefore written ON that host:
 *
 * - the BODY travels on stdin, never on an argv (a service env holds the
 *   service's credentials, and `ps` on a shared VM shows every argument);
 * - the body is literal `KEY=VALUE` lines — docker's env-file grammar has no
 *   quoting, no escapes and no `export`, so a `'` or a `"` in a value is part of
 *   the value and must be written as is;
 * - a newline in a value is refused: a second line would silently become
 *   another variable;
 * - the file is 0600 from the first byte (`umask 077`, temp file + `mv`) inside
 *   a 0700 directory that must be a real directory owned by the remote user (a
 *   symlink could point anywhere, and another user could have made it first).
 */

/** A POSIX shell variable name; docker would reject anything else too. */
export const DOCKER_ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

/** A service key names one file, so it is one plain path segment. */
const SERVICE_KEY_RE = /^[a-z0-9-]+$/;

/** `prepare` exit code for a refused dir (symlink or foreign owner), like `sshRunner`. */
const PREPARE_REFUSED_EXIT = 45;

/**
 * The content of a docker env file: sorted literal `KEY=VALUE` lines, each
 * ending in `\n`; the empty record is the empty string.
 *
 * Throws for a name docker could not read, and for a value holding a newline
 * (`\r` included: the file would carry a stray byte into the next line).
 */
export function dockerEnvFileContent(env: Readonly<Record<string, string>>): string {
  const lines = Object.keys(env)
    .sort()
    .map((key) => {
      if (!DOCKER_ENV_NAME_RE.test(key)) {
        throw new Error(`ssh docker: invalid env name ${JSON.stringify(key)}`);
      }
      const value = env[key]!;
      if (/\r|\n/.test(value)) {
        throw new Error(`ssh docker: env value for ${key} holds a newline`);
      }
      return `${key}=${value}`;
    });
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/**
 * The dirs a launch needs, 0700, each refused when it is a symlink or not owned
 * by the remote user (`[ -L ]`, `[ -O ]`: portable, no `stat -c`). Then the env
 * file from stdin, under `umask 077`, through a temp file + `mv`.
 */
function prepareScript(dirs: readonly string[], file: string): string {
  return [
    '# karst-ssh-docker-env',
    'umask 077',
    `refuse() { echo "karst: refusing $1: $2" >&2; exit ${String(PREPARE_REFUSED_EXIT)}; }`,
    'mkd() {',
    '  [ -L "$1" ] && refuse "$1" "it is a symlink"',
    '  mkdir -p -m 700 "$1" || exit 1',
    '  [ -L "$1" ] && refuse "$1" "it is a symlink"',
    '  [ -O "$1" ] || refuse "$1" "it is not owned by the remote user"',
    '  chmod 700 "$1" || exit 1',
    '}',
    ...dirs.map((dir) => `mkd ${sshQuote(dir)}`),
    `f=${sshQuote(file)}`,
    'cat > "$f.tmp" && chmod 600 "$f.tmp" && mv -f "$f.tmp" "$f"',
  ].join('\n');
}

function tail(text: string): string {
  const line = text.trim().split('\n').filter((l) => l.trim() !== '').at(-1);
  return line === undefined ? '' : line.slice(0, 300);
}

function failure(remoteName: string, step: string, out: SshResult): Error {
  if (out.transport === true) {
    const detail = tail(out.stderr);
    return new Error(`ssh ${remoteName}: transport failed during ${step}${detail === '' ? '' : `: ${detail}`}`);
  }
  const detail = tail(out.stderr);
  return new Error(`ssh ${remoteName}: ${step} failed (exit ${String(out.code)})${detail === '' ? '' : `: ${detail}`}`);
}

export interface RemoteDockerEnvFileInput {
  readonly ssh: SshProcess;
  readonly remote: RemoteDef;
  readonly remoteName: string;
  readonly controlDir: string;
  /** `<remoteDir>/<name>`: every `dirs` entry and `file` must live under it. */
  readonly workspace: string;
  /** The env file to write (`<ws>/env/docker.env`, `<ws>/env/svc-<key>.env`). */
  readonly file: string;
  /** Dirs to create/verify 0700 before the write, in order (parents first). */
  readonly dirs: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Write one env file on the remote over stdin. Throws (never a partial file,
 * never a fallback) when the body is invalid, the dirs are refused, the write
 * fails or the transport drops: the launch then fails closed.
 */
export async function writeRemoteDockerEnvFile(input: RemoteDockerEnvFileInput): Promise<void> {
  const body = dockerEnvFileContent(input.env);
  const prefix = `${input.workspace}/`;
  if (!input.file.startsWith(prefix) || input.file.includes('/../') || input.file.endsWith('/..')) {
    throw new Error(`ssh docker: refusing env file ${JSON.stringify(input.file)} (outside ${input.workspace})`);
  }
  const out = await input.ssh.runWithStdin(
    sshArgv(input.remote, input.controlDir, prepareScript(input.dirs, input.file)),
    Buffer.from(body, 'utf8'),
  );
  if (out.transport === true || out.code !== 0) throw failure(input.remoteName, 'env file write', out);
}

/** `<ws>/env/svc-<key>.env`; the key is one file name segment, so it is validated first. */
export function serviceEnvFilePath(workspace: string, key: string): string {
  if (!SERVICE_KEY_RE.test(key)) {
    throw new Error(`ssh docker: invalid service env key ${JSON.stringify(key)}`);
  }
  return `${workspace}/env/svc-${key}.env`;
}

/**
 * Remove `<ws>/env/svc-<key>.env`. Best effort, like the caller
 * (`stopSandboxService` removes it WITH the stopped process and keeps going):
 * a missing file is fine (`rm -f`) and a failed removal only leaves a 0600 file
 * nobody reads. The key itself is still validated, so a bad key never reaches
 * the remote as a path.
 */
export async function removeRemoteServiceEnv(
  ssh: SshProcess,
  remote: RemoteDef,
  controlDir: string,
  workspace: string,
  key: string,
): Promise<void> {
  const file = serviceEnvFilePath(workspace, key);
  await ssh.run(sshArgv(remote, controlDir, `# karst-ssh-docker-env-rm\nrm -f -- ${sshQuote(file)}`));
}

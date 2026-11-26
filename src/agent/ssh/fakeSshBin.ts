import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sshQuote } from './sshQuote.js';

/**
 * The fake `ssh` binary for integration tests (D554, Part A.4).
 *
 * It behaves the way sshd does for the one thing the seam depends on: it skips
 * the hardened options up to `--`, drops the destination, and runs the LAST
 * argument through the user's login shell (`${KARST_FAKE_LOGIN_SHELL:-/bin/sh}
 * -c "$cmd"`) inside a temp "remote root" directory. Every command that karst
 * sends runs there, so a test can inspect what the remote wrote.
 *
 * The helper also writes `rejectLoginShell`: a login shell that accepts only a
 * command starting with `sh -c ` (exactly what `remoteSh` produces). Point
 * `KARST_FAKE_LOGIN_SHELL` at it and a caller that forgot `remoteSh` fails
 * loudly instead of passing because the fake silently ran a bare script.
 */

export interface FakeSshBin {
  /** The fake `ssh` executable. */
  readonly ssh: string;
  /** Its directory, for a `PATH` override. */
  readonly binDir: string;
  /** The "remote machine" root; every fake command runs here. */
  readonly remoteRoot: string;
  /** A login shell that rejects any command not starting with `sh -c `. */
  readonly rejectLoginShell: string;
  /** Remove the temp tree this helper made. */
  cleanup(): Promise<void>;
}

export interface FakeSshBinOptions {
  /** A remote root to reuse; defaults to `<temp>/remote`. */
  readonly remoteRoot?: string;
}

function sshScript(remoteRoot: string): string {
  return `#!/bin/sh
# Fake ssh (fakeSshBin): skip the options up to --, drop the destination, and
# run the last argument the way sshd runs a command: the login shell with -c.
while [ "$#" -gt 0 ]; do
  case "$1" in
    --) shift; break ;;
    *) shift ;;
  esac
done
if [ "$#" -lt 1 ]; then
  echo "fake ssh: missing destination after --" >&2
  exit 255
fi
shift
cmd=""
for arg in "$@"; do
  cmd="$arg"
done
if [ -z "$cmd" ]; then
  echo "fake ssh: missing remote command" >&2
  exit 255
fi
root=${sshQuote(remoteRoot)}
if [ -n "\${KARST_FAKE_REMOTE_ROOT:-}" ]; then
  root="\${KARST_FAKE_REMOTE_ROOT}"
fi
cd "$root" || { echo "fake ssh: cannot cd to $root" >&2; exit 255; }
exec "\${KARST_FAKE_LOGIN_SHELL:-/bin/sh}" -c "$cmd"
`;
}

const REJECT_LOGIN_SHELL = `#!/bin/sh
# A login shell that only accepts the remoteSh form. sshd runs every command
# through the user's login shell; a bare script must fail here.
if [ "$#" -lt 2 ] || [ "$1" != "-c" ]; then
  echo "fake login shell: expected -c <command>" >&2
  exit 97
fi
cmd="$2"
case "$cmd" in
  "sh -c "*) exec /bin/sh -c "$cmd" ;;
  *) echo "fake login shell: rejected a command that does not start with 'sh -c ':" "$cmd" >&2; exit 97 ;;
esac
`;

export async function makeFakeSshBin(opts: FakeSshBinOptions = {}): Promise<FakeSshBin> {
  const root = await mkdtemp(join(tmpdir(), 'karst-fake-ssh-'));
  const binDir = join(root, 'bin');
  const remoteRoot = opts.remoteRoot ?? join(root, 'remote');
  await mkdir(binDir, { recursive: true });
  await mkdir(remoteRoot, { recursive: true });
  const ssh = join(binDir, 'ssh');
  const rejectLoginShell = join(binDir, 'reject-login-shell');
  await writeFile(ssh, sshScript(remoteRoot), { mode: 0o755 });
  await chmod(ssh, 0o755);
  await writeFile(rejectLoginShell, REJECT_LOGIN_SHELL, { mode: 0o755 });
  await chmod(rejectLoginShell, 0o755);
  return {
    ssh,
    binDir,
    remoteRoot,
    rejectLoginShell,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

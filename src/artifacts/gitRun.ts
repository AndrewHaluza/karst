import { execFile } from 'node:child_process';

/** Hardened git env: no user/system config, no hooks, no filters, no prompts. */
export function hardenedGitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'karst',
    GIT_AUTHOR_EMAIL: 'karst@localhost',
    GIT_COMMITTER_NAME: 'karst',
    GIT_COMMITTER_EMAIL: 'karst@localhost',
    LC_ALL: 'C',
  };
}

const HARD_CONFIG = ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false'];

/** Run git against a bare store repo. Async: never blocks the extension host. */
export function runGit(
  gitDir: string,
  args: readonly string[],
  opts: { input?: Buffer | string; env?: NodeJS.ProcessEnv } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      [...HARD_CONFIG, '--git-dir', gitDir, ...args],
      { env: { ...hardenedGitEnv(), ...opts.env }, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`git ${args[0]} failed: ${stderr.toString().trim() || err.message}`));
          return;
        }
        resolve(stdout);
      },
    );
    // git may exit before reading all of stdin (EPIPE); the exit code carries
    // the failure, so an unhandled stream error must not reach the host.
    child.stdin?.on('error', () => {});
    child.stdin?.end(opts.input);
  });
}

export async function runGitText(
  gitDir: string,
  args: readonly string[],
  opts: { input?: Buffer | string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return (await runGit(gitDir, args, opts)).toString('utf8');
}

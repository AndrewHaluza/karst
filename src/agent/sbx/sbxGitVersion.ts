/** Oldest git the sandbox may carry: `git worktree add --relative-paths` (scripts/eval/snapshot.mjs) needs 2.42. */
export const MIN_SANDBOX_GIT = '2.42';

export type SandboxGitCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const VERSION = /git version (\d+)\.(\d+)(?:\.(\d+))?/;

/** Compare the sandbox's `git --version` output with the minimum. Unparseable output fails closed. */
export function checkSandboxGit(output: string): SandboxGitCheck {
  const m = VERSION.exec(output);
  if (!m) {
    return { ok: false, reason: `sandbox git version unreadable (${output.trim().slice(0, 200)}); rebuild the sandbox image` };
  }
  const [major, minor] = [Number(m[1]), Number(m[2])];
  const [minMajor, minMinor] = MIN_SANDBOX_GIT.split('.').map(Number) as [number, number];
  if (major > minMajor || (major === minMajor && minor >= minMinor)) return { ok: true };
  const found = [m[1], m[2], m[3]].filter((p) => p !== undefined).join('.');
  return { ok: false, reason: `sandbox git ${found} is older than ${MIN_SANDBOX_GIT}; rebuild the sandbox image` };
}

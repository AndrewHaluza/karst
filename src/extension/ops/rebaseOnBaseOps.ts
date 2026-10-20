/**
 * "Rebase on base" (ship stage): rebase the PR branch onto its base on the host,
 * regenerate declared generated files, force-with-lease push, then recreate the
 * sandbox clone from the rebased branch (D198 no-sync Remove path).
 *
 * This is the ONLY force path in karst, and it is scoped: the lease names the
 * PR head sha the host last saw, so a remote that moved is never overwritten.
 * Every collaborator is injected; the ticket never leaves ship.
 */

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RebaseDeps {
  readonly repo: string;
  readonly cwd: string;
  readonly branch: string;
  readonly baseRef: string;
  /** Repo-declared generator commands (`ship.regenerate`); empty = none. */
  readonly regenerate: readonly string[];
  readonly git: (cwd: string, args: readonly string[]) => Promise<GitResult>;
  readonly runScript: (cwd: string, command: string) => Promise<{ code: number; stderr: string }>;
  /** True while an agent turn is running for the ticket. Checked for the whole action. */
  readonly agentActive: () => boolean;
  /** True when the sandbox clone holds commits the host branch lacks. */
  readonly sandboxUnsynced: () => Promise<boolean>;
  /** Live PR head sha: the expected remote value of the lease. */
  readonly prHeadSha: () => Promise<string>;
  readonly removeSandbox: () => Promise<void>;
  readonly reopenSandbox: () => Promise<void>;
  readonly reprobe: () => Promise<void>;
  readonly confirm: (message: string) => Promise<boolean>;
  readonly info: (message: string) => void;
  readonly error: (message: string) => void;
  readonly logError: (message: string, err: unknown) => void;
  readonly afterServerChange: () => void;
}

const BUSY = 'Rebase on base: agent is working; try when idle.';
const UNSYNCED = 'Rebase on base: sync or carry sandbox commits first.';

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function rebaseOnBase(deps: RebaseDeps): Promise<void> {
  try {
    await run(deps);
  } catch (err) {
    deps.logError('rebaseOnBase failed', err);
    deps.error(`Rebase on base failed: ${message(err)}`);
  } finally {
    deps.afterServerChange();
  }
}

async function run(d: RebaseDeps): Promise<void> {
  if (d.agentActive()) return d.error(BUSY);
  if (await d.sandboxUnsynced()) return d.error(UNSYNCED);
  const ok = await d.confirm(
    `Rebase ${d.branch} onto origin/${d.baseRef} in ${d.repo} and force-push (with lease)?`,
  );
  if (!ok) return;

  const orig = await d.git(d.cwd, ['rev-parse', 'HEAD']);
  const origHead = orig.stdout.trim();
  if (!(await rebased(d))) return;
  if (!(await regenerated(d, origHead))) return;

  let sha: string;
  try {
    sha = await d.prHeadSha();
  } catch (err) {
    await d.git(d.cwd, ['reset', '--hard', origHead]);
    return d.error(`Rebase on base: could not read the PR head (${message(err)}); nothing pushed.`);
  }
  if (d.agentActive()) {
    await d.git(d.cwd, ['reset', '--hard', origHead]);
    return d.error(BUSY);
  }
  const push = await d.git(d.cwd, [
    'push',
    `--force-with-lease=${d.branch}:${sha}`,
    'origin',
    `HEAD:refs/heads/${d.branch}`,
  ]);
  if (push.code !== 0) {
    await d.git(d.cwd, ['reset', '--hard', origHead]);
    return d.error(
      `Rebase on base: push rejected (lease: the remote branch moved, or push failed): ${push.stderr.trim()}. Sandbox left as is.`,
    );
  }
  await recreate(d);
  await d.reprobe();
}

async function rebased(d: RebaseDeps): Promise<boolean> {
  const fetch = await d.git(d.cwd, ['fetch', 'origin', d.baseRef]);
  if (fetch.code !== 0) {
    d.error(`Rebase on base: fetch failed: ${fetch.stderr.trim()}`);
    return false;
  }
  const rebase = await d.git(d.cwd, ['rebase', `origin/${d.baseRef}`]);
  if (rebase.code === 0) return true;
  await d.git(d.cwd, ['rebase', '--abort']);
  d.error(
    `Rebase on base: conflict rebasing onto origin/${d.baseRef}; rebase aborted, nothing changed. ${rebase.stderr.trim()}`,
  );
  return false;
}

async function regenerated(d: RebaseDeps, origHead: string): Promise<boolean> {
  if (d.regenerate.length === 0) return true;
  for (const command of d.regenerate) {
    const res = await d.runScript(d.cwd, command);
    if (res.code !== 0) {
      await d.git(d.cwd, ['reset', '--hard', origHead]);
      d.error(`Rebase on base: generator \`${command}\` failed (${res.stderr.trim()}); branch restored, nothing pushed.`);
      return false;
    }
  }
  const status = await d.git(d.cwd, ['status', '--porcelain']);
  if (status.stdout.trim() === '') return true;
  await d.git(d.cwd, ['add', '-A']);
  const commit = await d.git(d.cwd, ['commit', '-m', 'chore: regenerate generated files after rebase']);
  if (commit.code === 0) return true;
  await d.git(d.cwd, ['reset', '--hard', origHead]);
  d.error(`Rebase on base: committing regenerated files failed: ${commit.stderr.trim()}; branch restored.`);
  return false;
}

/** After a successful push only: failures here report, the push stands. */
async function recreate(d: RebaseDeps): Promise<void> {
  if (d.agentActive()) return d.error(`Pushed ${d.branch}. ${BUSY} Recreate the sandbox once idle.`);
  if (await d.sandboxUnsynced()) {
    return d.error(
      `Pushed ${d.branch}, but new sandbox commits appeared; sync or carry them, then recreate the sandbox.`,
    );
  }
  try {
    await d.removeSandbox();
    await d.reopenSandbox();
    d.info(`Rebased ${d.branch} onto origin/${d.baseRef}, pushed, and recreated the sandbox.`);
  } catch (err) {
    d.logError('rebaseOnBase recreate failed', err);
    d.error(`Pushed ${d.branch}, but recreating the sandbox failed: ${message(err)}`);
  }
}

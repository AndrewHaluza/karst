import type { GitRunner } from '../integrations/git.js';
import type { Store } from '../store/db.js';
import { listWorktreesByTicket } from '../store/dashboard.js';

/** The one command that refreshes the parity snapshot and the layout ledger together. */
export const UI_PARITY_UPDATE_COMMAND = 'npm run -s ui:parity:update';

const UI_PREFIX = 'src/ui/';
const MAX_NAMED_FAILURES = 10;

export interface ParityResult {
  ok: boolean;
  /** Names of the failing snapshots (empty when `ok`). */
  failures: string[];
}

/** Runs the fast dashboard parity vitest in one worktree. Injected for tests. */
export type ParityRunner = (cwd: string) => Promise<ParityResult>;

/** Whether the worktree diff (committed and uncommitted) from its base touches `src/ui/`. */
async function touchesUi(git: GitRunner, cwd: string, baseRef: string | null): Promise<boolean> {
  if (!baseRef) return false;
  let from = baseRef;
  for (const spec of [`origin/${baseRef}`, baseRef]) {
    const mb = await git(['merge-base', 'HEAD', spec], cwd);
    if (mb.exitCode === 0 && mb.stdout.trim() !== '') {
      from = mb.stdout.trim();
      break;
    }
  }
  const diff = await git(['diff', '--name-only', from], cwd);
  if (diff.exitCode !== 0) return false;
  const untracked = await git(['ls-files', '--others', '--exclude-standard'], cwd);
  const files = [...diff.stdout.split('\n'), ...(untracked.exitCode === 0 ? untracked.stdout.split('\n') : [])];
  return files.some((f) => f.startsWith(UI_PREFIX));
}

/**
 * Refuse the impl/fix done marker when the ticket diff touches `src/ui/**` and
 * the dashboard parity test fails (@ui:LEDGER-SHIFT). Only the fast parity
 * vitest runs here; the docker visual and layout runs stay in UAT. A probe
 * karst cannot answer lets the marker through, like the other marker guards.
 */
export async function assertUiParityFresh(
  store: Store,
  ticketId: number,
  git: GitRunner,
  runParity: ParityRunner,
): Promise<void> {
  for (const w of listWorktreesByTicket(store, ticketId)) {
    if (!(await touchesUi(git, w.path, w.baseRef))) continue;
    const result = await runParity(w.path);
    if (result.ok) continue;
    const names = result.failures.slice(0, MAX_NAMED_FAILURES).join('; ') || 'see the vitest output';
    throw new Error(
      `cannot mark this stage done: the ticket changes src/ui/** and the dashboard parity test fails in ${w.path}. ` +
        `Failing snapshots: ${names}. ` +
        `Check that each change is intended, then run \`${UI_PARITY_UPDATE_COMMAND}\` ` +
        '(updates the parity snapshot, prunes or seeds the layout ledger), commit, and fire the marker again.',
    );
  }
}

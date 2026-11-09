import type { GitRunner } from '../integrations/git.js';
import type { Store } from '../store/db.js';
import { listWorktreesByTicket } from '../store/dashboard.js';

const DOCS_PREFIX = 'docs/';
const MAX_NAMED_ERRORS = 10;
// One `docsKeys.mjs lint` error line: `<file>: <key> exceeds <cap> B (<n>)...`. Warnings never match.
const OVERSIZE_LINE = /^(docs\/\S+): (\S+) exceeds (\d+) B \((\d+)\)/;

/**
 * Runs the block-size lint (`node scripts/docsKeys.mjs lint`) in one worktree and
 * returns its combined output. Injected for tests. A spawn error or timeout
 * throws; a non-zero exit with output is a normal answer.
 */
export type DocsLintRunner = (cwd: string) => Promise<string>;

/** Docs files the worktree diff (committed and uncommitted) changed against its base. */
async function changedDocs(git: GitRunner, cwd: string, baseRef: string | null): Promise<Set<string>> {
  if (!baseRef) return new Set();
  let from = baseRef;
  for (const spec of [`origin/${baseRef}`, baseRef]) {
    const mb = await git(['merge-base', 'HEAD', spec], cwd);
    if (mb.exitCode === 0 && mb.stdout.trim() !== '') {
      from = mb.stdout.trim();
      break;
    }
  }
  const diff = await git(['diff', '--name-only', from], cwd);
  if (diff.exitCode !== 0) return new Set();
  const untracked = await git(['ls-files', '--others', '--exclude-standard'], cwd);
  const files = [...diff.stdout.split('\n'), ...(untracked.exitCode === 0 ? untracked.stdout.split('\n') : [])];
  return new Set(files.map((f) => f.trim()).filter((f) => f.startsWith(DOCS_PREFIX)));
}

/**
 * Refuse the impl/fix done marker when a `docs/**` file the ticket changed holds
 * a block over the size cap (@arch:DOC-01). The UAT `docs` gate would fail on it
 * and open a fix round. Only oversize errors in changed files refuse; warnings
 * and errors in untouched files never do. A lint karst cannot run lets the
 * marker through, like the other marker guards.
 */
export async function assertDocsBlocksWithinCap(
  store: Store,
  ticketId: number,
  git: GitRunner,
  runLint: DocsLintRunner,
): Promise<void> {
  for (const w of listWorktreesByTicket(store, ticketId)) {
    const changed = await changedDocs(git, w.path, w.baseRef);
    if (changed.size === 0) continue;
    const output = await runLint(w.path);
    const hits: string[] = [];
    for (const line of output.split('\n')) {
      const m = OVERSIZE_LINE.exec(line.trim());
      if (m && changed.has(m[1]!)) hits.push(`${m[1]}: ${m[2]} exceeds ${m[3]} B (${m[4]})`);
    }
    if (hits.length === 0) continue;
    throw new Error(
      `cannot mark this stage done: ${hits.slice(0, MAX_NAMED_ERRORS).join('; ')}; ` +
        'split the block (docs/arch/README.md @arch:DOC-01), then fire the marker',
    );
  }
}

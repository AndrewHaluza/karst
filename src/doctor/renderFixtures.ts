/**
 * Populated states for the Doctor page, one per row of its States table. The
 * renderer test drives every fixture, so a state the page can show is also a
 * state a test proves.
 *
 * These are DATA, not probes: no fixture touches the machine, and every fix is
 * a literal so the page's fix wording can be checked without a repository.
 */
import { DOCTOR_AREAS, type AppliedFix, type DoctorArea, type DoctorCheck, type DoctorReport } from './types.js';
import { summarize } from './run.js';

function pass(id: string, area: DoctorArea, title: string, detail: string): DoctorCheck {
  return { id, area, status: 'ok', title, detail };
}

function makeReport(checks: readonly DoctorCheck[], applied: readonly AppliedFix[] = [], fixRequested = false): DoctorReport {
  const summary = summarize(checks);
  return {
    areas: [...DOCTOR_AREAS],
    fixRequested,
    checks: [...checks],
    applied: [...applied],
    summary,
    exitCode: summary.fail > 0 ? 1 : 0,
  };
}

/** The four areas, all passing — the first-run page. */
const allOk: DoctorReport = makeReport([
  pass('tools.git', 'tools', 'Git', 'Git 2.45.2 is installed.'),
  pass('tools.node', 'tools', 'Node', 'Node 22.4.0 is installed.'),
  pass('manifest.repos', 'manifest', 'Repositories', '3 repositories are configured.'),
  pass('state.worktrees', 'state', 'Recorded worktrees', 'Checked 4 recorded worktrees; none need attention.'),
  pass('state.servers', 'state', 'Recorded servers', 'Checked 2 server rows; none dead or leaked.'),
  pass('wiring.launcher', 'wiring', 'Launcher', 'The launch script is present.'),
]);

/** Two findings: one prose instruction, one exact command the user runs. */
const warnings: DoctorReport = makeReport([
  pass('tools.git', 'tools', 'Git', 'Git 2.45.2 is installed.'),
  {
    id: 'tools.npm',
    area: 'tools',
    status: 'warn',
    title: 'Npm',
    detail: 'Npm 10.2.0 is older than 10.8.0.',
    fix: {
      tier: 'report',
      summary: 'Upgrade npm',
      nextStep: 'Upgrade npm to 10.8.0 or newer, then reload the window.',
    },
  },
  pass('manifest.repos', 'manifest', 'Repositories', '3 repositories are configured.'),
  {
    id: 'state.sandbox-disk',
    area: 'state',
    status: 'warn',
    title: 'Sandbox disk usage',
    detail: '2 sandboxes, size unknown, karst images ~5.6 GB, build cache ~4.7 GB.',
    fix: { tier: 'consented', summary: 'Prune the sandbox images', command: 'sbx prune --all' },
  },
]);

/** Every auto fix the confirmation modal can list — three kinds. */
const autoFixes: DoctorReport = makeReport([
  pass('tools.git', 'tools', 'Git', 'Git 2.45.2 is installed.'),
  {
    id: 'state.server-leaked.4123',
    area: 'state',
    status: 'warn',
    title: 'Leaked server',
    detail: 'Server 12 leaked process 4123 after its ticket finished.',
    fix: {
      tier: 'auto',
      summary: 'Kill leaked server process 4123',
      action: { kind: 'kill-process', serverId: 12, pid: 4123, startedAt: '2026-01-01T10:00:00Z' },
    },
  },
  {
    id: 'state.worktree-prune.7',
    area: 'state',
    status: 'warn',
    title: 'Worktree prune',
    detail: 'Worktree /tmp/wt/api is clean and its ticket is done.',
    fix: {
      tier: 'auto',
      summary: 'Prune clean worktree /tmp/wt/api',
      action: { kind: 'prune-worktree', ticketId: 7, repo: 'api', path: '/tmp/wt/api', branch: 'karst/t7' },
    },
  },
  {
    id: 'state.server-dead.12',
    area: 'state',
    status: 'warn',
    title: 'Dead server',
    detail: 'Server 12 is recorded running but its process is gone.',
    fix: { tier: 'auto', summary: 'Mark server 12 stopped', action: { kind: 'mark-server-stopped', serverId: 12, pid: null } },
  },
]);

/** A run that applied one fix and skipped one. */
const applied: DoctorReport = makeReport(
  [
    pass('tools.git', 'tools', 'Git', 'Git 2.45.2 is installed.'),
    pass('state.server-leaked', 'state', 'Leaked server', 'No leaked karst-spawned processes are left.'),
    {
      id: 'state.worktree-prune.7',
      area: 'state',
      status: 'warn',
      title: 'Worktree prune',
      detail: 'Worktree /tmp/wt/api is dirty, so the prune was skipped.',
      fix: {
        tier: 'auto',
        summary: 'Prune clean worktree /tmp/wt/api',
        action: { kind: 'prune-worktree', ticketId: 7, repo: 'api', path: '/tmp/wt/api', branch: 'karst/t7' },
      },
    },
  ],
  [
    {
      checkId: 'state.server-leaked.4123',
      what: 'killed pid 4123',
      why: 'leaked karst-spawned process after its ticket finished',
      evidence: 'pid 4123 started 2026-01-01T09:59:00Z, recorded 2026-01-01T10:00:00Z',
      ok: true,
    },
    {
      checkId: 'state.worktree-prune.7',
      what: 'skipped prune of /tmp/wt/api',
      why: 'worktree is dirty',
      evidence: '/tmp/wt/api',
      ok: false,
    },
  ],
  true,
);

/** A probe that could not answer is "Not checked", never a warning. */
const skipped: DoctorReport = makeReport([
  pass('tools.git', 'tools', 'Git', 'Git 2.45.2 is installed.'),
  {
    id: 'state.worktree-prune.unknown',
    area: 'state',
    status: 'skipped',
    title: 'Worktree prune',
    detail: 'Could not read the worktree state from git.',
    fix: {
      tier: 'report',
      summary: 'Check the worktree by hand',
      nextStep: 'Run git status in the worktree, then run the checks again.',
    },
  },
  pass('wiring.launcher', 'wiring', 'Launcher', 'The launch script is present.'),
]);

/** Every populated page state the renderer can be asked to draw. */
export const DOCTOR_FIXTURES = {
  'all-ok': allOk,
  warnings,
  'auto-fixes': autoFixes,
  applied,
  skipped,
} as const;

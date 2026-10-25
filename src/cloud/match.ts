/**
 * Choose the ticket a cloud session belongs to (arch:CLOUD-01). Pure and
 * display-only. Priority, stopping at the FIRST rule that yields any
 * candidate: (a) PR, (b) branch, (c) ticket key (branch name or commit subject; a PR title adds nothing because any PR whose head carries the URL is already decided by (a)). More than one candidate
 * ticket at the deciding rule means unlinked — never guess.
 */

export type CloudMatchSource = 'pr' | 'branch' | 'key';

export interface CloudMatchTicket {
  id: number;
  key: string | null;
  /** Every branch the ticket owns (one per repo worktree). */
  branches: readonly string[];
}

export interface CloudMatchPr {
  ticketId: number;
  headRef: string | null;
  body: string;
}

/** One commit message, with the branch it was read from. */
export interface CloudMatchCommit {
  branch: string;
  message: string;
}

export interface CloudMatchInput {
  url: string;
  /** Tickets of ONE project only; keys are unique within it. */
  tickets: readonly CloudMatchTicket[];
  prs: readonly CloudMatchPr[];
  commits: readonly CloudMatchCommit[];
}

export interface CloudMatch {
  ticketId: number;
  source: CloudMatchSource;
}

/** `key` appears as a whole token: not glued to a longer key (`PROJ-14` vs `PROJ-142`). */
export function containsTicketKey(text: string, key: string): boolean {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, 'i').test(text);
}

function decide(ids: Set<number>, source: CloudMatchSource): CloudMatch | null | undefined {
  if (ids.size === 0) return undefined;
  if (ids.size > 1) return null;
  return { ticketId: [...ids][0]!, source };
}

export function matchCloudSession(input: CloudMatchInput): CloudMatch | null {
  const carrying = input.commits.filter((c) => c.message.includes(input.url));
  const carryingBranches = new Set(carrying.map((c) => c.branch));

  const prIds = new Set<number>();
  for (const pr of input.prs) {
    if (pr.body.includes(input.url) || (pr.headRef !== null && carryingBranches.has(pr.headRef))) {
      prIds.add(pr.ticketId);
    }
  }
  const byPr = decide(prIds, 'pr');
  if (byPr !== undefined) return byPr;

  const branchIds = new Set<number>();
  for (const t of input.tickets) {
    if (t.branches.some((b) => carryingBranches.has(b))) branchIds.add(t.id);
  }
  const byBranch = decide(branchIds, 'branch');
  if (byBranch !== undefined) return byBranch;

  const texts = [
    ...carryingBranches,
    ...carrying.map((c) => c.message.split('\n', 1)[0] ?? ''),
  ];
  const keyIds = new Set<number>();
  for (const t of input.tickets) {
    if (t.key && texts.some((x) => containsTicketKey(x, t.key!))) keyIds.add(t.id);
  }
  return decide(keyIds, 'key') ?? null;
}

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { MAX_SETUP_PROPOSAL_BYTES } from './proposal.js';

/**
 * The setup session's proposal ledger. The HOST writes one result file per
 * proposal into `<outbox>/results/<id>.json`; `karst setup status` reads them.
 * The ledger is display only: the host never reads it to decide anything, so an
 * agent that forges a file there changes nothing but its own `status` output.
 * A pending proposal is derived from the outbox itself, not from a result.
 */

export type ProposalStatus = 'pending' | 'applied' | 'declined' | 'invalid' | 'superseded' | 'withdrawn';

export interface ProposalResult {
  id: string;
  kind: 'manifest' | 'change' | 'unknown';
  status: ProposalStatus;
  reason?: string;
  /** Protected fields the apply discarded (manifest proposals). */
  dropped: string[];
  /** sha256 of karst.yml after an apply. */
  sha256?: string;
  at: string;
}

const ID = /^[A-Za-z0-9-]{1,64}$/;
const STATUSES: readonly string[] = ['pending', 'applied', 'declined', 'invalid', 'superseded', 'withdrawn'];

export const resultsDir = (outbox: string): string => join(outbox, 'results');
export const withdrawnDir = (outbox: string): string => join(outbox, 'withdrawn');

export function writeProposalResult(outbox: string, result: ProposalResult): void {
  const dir = resultsDir(outbox);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${randomUUID()}`);
  writeFileSync(tmp, JSON.stringify(result), { mode: 0o600 });
  renameSync(tmp, join(dir, `${result.id}.json`));
}

function readResult(file: string): ProposalResult | undefined {
  try {
    if (statSync(file).size > MAX_SETUP_PROPOSAL_BYTES) return undefined;
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ProposalResult>;
    if (typeof raw.status !== 'string' || !STATUSES.includes(raw.status)) return undefined;
    return {
      id: basename(file, '.json'),
      kind: raw.kind === 'manifest' || raw.kind === 'change' ? raw.kind : 'unknown',
      status: raw.status as ProposalStatus,
      ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
      dropped: Array.isArray(raw.dropped) ? raw.dropped.filter((d): d is string => typeof d === 'string') : [],
      ...(typeof raw.sha256 === 'string' ? { sha256: raw.sha256 } : {}),
      at: typeof raw.at === 'string' ? raw.at : '',
    };
  } catch {
    return undefined;
  }
}

function pendingKind(file: string): ProposalResult['kind'] {
  try {
    if (statSync(file).size > MAX_SETUP_PROPOSAL_BYTES) return 'unknown';
    const kind = (JSON.parse(readFileSync(file, 'utf8')) as { kind?: unknown }).kind;
    return kind === 'manifest' || kind === 'change' ? kind : 'unknown';
  } catch {
    return 'unknown';
  }
}

const list = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('.'));
  } catch {
    return [];
  }
};

/** Every proposal of the session: host results, withdrawals, then still-pending files. */
export function readLedger(outbox: string): ProposalResult[] {
  const out = new Map<string, ProposalResult>();
  for (const name of list(outbox)) {
    const id = basename(name, '.json');
    const file = join(outbox, name);
    out.set(id, {
      id,
      kind: pendingKind(file),
      status: 'pending',
      dropped: [],
      at: statSync(file).mtime.toISOString(),
    });
  }
  try {
    for (const id of readdirSync(withdrawnDir(outbox))) {
      if (ID.test(id)) out.set(id, { id, kind: 'unknown', status: 'withdrawn', dropped: [], at: '' });
    }
  } catch {
    /* no withdrawals */
  }
  for (const name of list(resultsDir(outbox))) {
    const result = readResult(join(resultsDir(outbox), name));
    if (result !== undefined) out.set(result.id, result);
  }
  return [...out.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

/**
 * Remove a still-pending proposal and leave a withdrawal marker the ledger
 * reads. The host re-checks the file after the consent modal, so a proposal
 * withdrawn while its modal is open is not applied.
 */
export function withdrawProposal(outbox: string, id: string): { ok: true } | { ok: false; error: string } {
  if (!ID.test(id)) return { ok: false, error: `invalid proposal id '${id}'` };
  const file = join(outbox, `${id}.json`);
  if (!existsSync(file)) return { ok: false, error: `no pending proposal '${id}'` };
  mkdirSync(withdrawnDir(outbox), { recursive: true });
  writeFileSync(join(withdrawnDir(outbox), id), '');
  unlinkSync(file);
  return { ok: true };
}

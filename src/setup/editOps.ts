import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_SETUP_PROPOSAL_BYTES } from './proposal.js';

/**
 * The setup session's EDIT LIST: one file per typed tool call in
 * `<outbox>/edits/`. The host never supersedes an edit; one popup shows all of
 * them, and the host applies them in order to the latest karst.yml. The files
 * live in their own directory so the proposal scan and the ledger never read
 * them as a proposal. The agent can write here directly, so the host re-reads
 * and re-validates every op (bounded, shape-checked) before it trusts it.
 */

export interface EditOpFile {
  id: string;
  /** Sort key: the file name sorts in call order. */
  seq: string;
  tool: string;
  input: Record<string, unknown>;
}

const ID = /^[A-Za-z0-9-]{1,64}$/;
const SEQ_WIDTH = 15;

export const editsDir = (outbox: string): string => join(outbox, 'edits');

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const padSeq = (n: number): string => String(n).padStart(SEQ_WIDTH, '0');
const newestSeq = (outbox: string): string => readEditOps(outbox).reduce((max, op) => (op.seq > max ? op.seq : max), '');

/**
 * Claim the next op sequence key: the clock, padded, so file names sort in call
 * order. The claim is a file created with `wx`, so two concurrent calls never
 * get the same key; the later one counts on. Returns the key and the claim file.
 */
function claimSeq(outbox: string, now: () => number): { seq: string; release: () => void } {
  const dir = editsDir(outbox);
  mkdirSync(dir, { recursive: true });
  let n = Math.max(now(), 0);
  for (;;) {
    const last = newestSeq(outbox);
    if (last >= padSeq(n)) n = Number(last) + 1; // the clock did not move (or ran back)
    const seq = padSeq(n);
    const claim = join(dir, `.seq-${seq}`);
    try {
      writeFileSync(claim, '', { flag: 'wx', mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      n += 1;
      continue;
    }
    // An op may have landed between the read and the claim: check again.
    if (newestSeq(outbox) >= seq) {
      unlinkSync(claim);
      continue;
    }
    return { seq, release: () => unlinkSync(claim) };
  }
}

/** Append one op. Returns the op written. Bounded: an oversize op is refused before it touches disk. */
export function writeEditOp(
  outbox: string,
  tool: string,
  input: Record<string, unknown>,
  deps: { uuid?: () => string; now?: () => number } = {},
): EditOpFile {
  const id = (deps.uuid ?? randomUUID)();
  const body = JSON.stringify({ id, seq: '', tool, input });
  if (Buffer.byteLength(body, 'utf8') > MAX_SETUP_PROPOSAL_BYTES - SEQ_WIDTH) {
    throw new Error(`edit is too large (max ${MAX_SETUP_PROPOSAL_BYTES} bytes)`);
  }
  const claim = claimSeq(outbox, deps.now ?? Date.now);
  const op: EditOpFile = { id, seq: claim.seq, tool, input };
  const dir = editsDir(outbox);
  const tmp = join(dir, `.tmp-${id}`);
  try {
    writeFileSync(tmp, JSON.stringify(op), { flag: 'wx', mode: 0o600 });
    try {
      renameSync(tmp, join(dir, `${op.seq}-${id}.json`));
    } catch (e) {
      unlinkSync(tmp);
      throw e;
    }
  } finally {
    claim.release();
  }
  return op;
}

function parseOp(file: string): EditOpFile | undefined {
  try {
    if (statSync(file).size > MAX_SETUP_PROPOSAL_BYTES) return undefined;
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isRecord(raw) || typeof raw.id !== 'string' || !ID.test(raw.id)) return undefined;
    if (typeof raw.seq !== 'string' || typeof raw.tool !== 'string' || !isRecord(raw.input)) return undefined;
    return { id: raw.id, seq: raw.seq, tool: raw.tool, input: raw.input };
  } catch {
    return undefined;
  }
}

/** The pending ops in call order. A file that is oversize or malformed is skipped. */
export function readEditOps(outbox: string): EditOpFile[] {
  const dir = editsDir(outbox);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('.'));
  } catch {
    return [];
  }
  const ops: EditOpFile[] = [];
  for (const name of names.sort()) {
    const op = parseOp(join(dir, name));
    if (op !== undefined) ops.push(op);
  }
  return ops.sort((a, b) => a.seq.localeCompare(b.seq) || a.id.localeCompare(b.id));
}

/** Remove one pending op. The host re-reads the list after its popup, so a withdrawn op is not applied. */
export function withdrawEditOp(outbox: string, id: string): { ok: true } | { ok: false; error: string } {
  if (!ID.test(id)) return { ok: false, error: `invalid edit id '${id}'` };
  const dir = editsDir(outbox);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    names = [];
  }
  // The id carries dashes, so a suffix match is not exact: read the id from each op.
  const name = names.find((n) => n.endsWith('.json') && !n.startsWith('.') && parseOp(join(dir, n))?.id === id);
  if (name === undefined) return { ok: false, error: `no pending edit '${id}'` };
  unlinkSync(join(dir, name));
  return { ok: true };
}

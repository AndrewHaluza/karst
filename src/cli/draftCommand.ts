import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { realpathSync, renameSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { MAX_PROPOSAL_BYTES, validateProposal } from '../planning/proposal.js';
import { readProposalIndex, waitForProposalId } from '../planning/proposalIndex.js';

/**
 * `karst draft propose` / `karst draft list` — how a PLANNING session works
 * with draft tickets.
 *
 * `propose` reads one JSON object from stdin, validates it with the shared
 * `validateProposal` (an optional integer `id` revises an existing draft), and
 * writes it atomically (tmp file, then rename) as `$KARST_OUTBOX/<uuid>.json`.
 * It then waits briefly for the host to ingest the file and publish the id in
 * the session's proposal index. `list` reads that index (no store) and prints
 * the session's drafts with their id, status and title.
 *
 * Neither opens a store, takes flags at all (`--db`/`--manifest`/`--session`
 * are refused) or reads any path but the two under `KARST_OUTBOX`. The host
 * ingests the outbox, checks repos against ITS manifest, and a human confirms
 * with the full content visible before any ticket exists (cli.md).
 */

export interface DraftProposeDeps {
  /** `KARST_OUTBOX` from the session env, read and injected by main.ts. */
  outboxEnv: string | undefined;
  /** Read stdin, at most `max` bytes (one more signals oversize). */
  readStdin: (max: number) => string;
  /** Injectable clock/sleep so tests can exercise the bounded id wait. */
  now?: () => number;
  sleep?: (ms: number) => void;
  timeoutMs?: number;
}

const USAGE = "usage: printf '%s' '<json>' | karst draft propose";

function outboxDir(env: string | undefined): string {
  if (!env) throw new Error('karst draft: KARST_OUTBOX is not set (run it inside a planning session)');
  try {
    const real = realpathSync(env);
    if (statSync(real).isDirectory()) return real;
  } catch {
    // fall through to the shared error
  }
  throw new Error(`karst draft: KARST_OUTBOX (${env}) is not a directory`);
}

/** The session scratch, the parent of the outbox dir, where the index lives. */
function scratchOf(outbox: string): string {
  return dirname(outbox);
}

function readProposal(stdin: string): unknown {
  if (Buffer.byteLength(stdin, 'utf8') > MAX_PROPOSAL_BYTES) {
    throw new Error(`karst draft propose: input is too large (max ${MAX_PROPOSAL_BYTES} bytes)`);
  }
  try {
    return JSON.parse(stdin);
  } catch {
    throw new Error('karst draft propose: stdin is not one JSON object');
  }
}

function runPropose(deps: DraftProposeDeps): string {
  const dir = outboxDir(deps.outboxEnv);
  const checked = validateProposal(readProposal(deps.readStdin(MAX_PROPOSAL_BYTES)));
  if (!checked.ok) throw new Error(`karst draft propose: ${checked.reason}`);

  const uuid = randomUUID();
  const tmp = join(dir, `.tmp-${uuid}`);
  const file = join(dir, `${uuid}.json`);
  writeFileSync(tmp, JSON.stringify(checked.value), { flag: 'wx', mode: 0o600 });
  try {
    renameSync(tmp, file);
  } catch (e) {
    unlinkSync(tmp);
    throw e;
  }

  const id = waitForProposalId(scratchOf(dir), uuid, {
    now: deps.now,
    sleep: deps.sleep,
    timeoutMs: deps.timeoutMs,
  });
  if (id === undefined) {
    return JSON.stringify({
      ok: true,
      file,
      id: null,
      hint: 'the host has not ingested it yet (or rejected it); run `karst draft list` to see its id',
    });
  }
  return JSON.stringify({ ok: true, file, id });
}

function runList(deps: DraftProposeDeps): string {
  const dir = outboxDir(deps.outboxEnv);
  const entries = readProposalIndex(scratchOf(dir));
  return JSON.stringify(entries.map(({ id, status, title }) => ({ id, status, title })));
}

export function runDraftCommand(argv: string[], deps: DraftProposeDeps): string {
  const [cmd, sub, ...rest] = argv;
  if (cmd !== 'draft') throw new Error(`karst draft: unknown command '${cmd ?? ''}'`);
  if (sub === 'propose') {
    if (rest.length > 0) throw new Error(`karst draft propose takes no arguments or flags (${USAGE})`);
    return runPropose(deps);
  }
  if (sub === 'list') {
    if (rest.length > 0) throw new Error('karst draft list takes no arguments or flags');
    return runList(deps);
  }
  throw new Error(`karst draft: unknown subcommand '${sub ?? ''}' (want 'propose' or 'list')`);
}

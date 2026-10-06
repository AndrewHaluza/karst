import { randomUUID } from 'node:crypto';
import { realpathSync, renameSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_PROPOSAL_BYTES, validateProposal } from '../planning/proposal.js';

/**
 * `karst draft propose` — how a PLANNING session proposes a draft ticket.
 *
 * It only PROPOSES: it reads one JSON object from stdin, validates it with the
 * shared `validateProposal`, and writes it atomically (tmp file, then rename)
 * as `$KARST_OUTBOX/<uuid>.json`. It opens NO store, takes no flags at all
 * (`--db`/`--manifest`/`--session` are refused) and reads no file paths. The
 * host ingests the outbox, checks repos against ITS manifest, and a human
 * confirms with the full content visible before any ticket exists (cli.md).
 */

export interface DraftProposeDeps {
  /** `KARST_OUTBOX` from the session env, read and injected by main.ts. */
  outboxEnv: string | undefined;
  /** Read stdin, at most `max` bytes (one more signals oversize). */
  readStdin: (max: number) => string;
}

const USAGE = "usage: printf '%s' '<json>' | karst draft propose";

function outboxDir(env: string | undefined): string {
  if (!env) throw new Error('karst draft propose: KARST_OUTBOX is not set (run it inside a planning session)');
  try {
    const real = realpathSync(env);
    if (statSync(real).isDirectory()) return real;
  } catch {
    // fall through to the shared error
  }
  throw new Error(`karst draft propose: KARST_OUTBOX (${env}) is not a directory`);
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

export function runDraftCommand(argv: string[], deps: DraftProposeDeps): string {
  const [cmd, sub, ...rest] = argv;
  if (cmd !== 'draft' || sub !== 'propose' || rest.length > 0) {
    throw new Error(`karst draft propose takes no arguments or flags (${USAGE})`);
  }
  const dir = outboxDir(deps.outboxEnv);
  const checked = validateProposal(readProposal(deps.readStdin(MAX_PROPOSAL_BYTES)));
  if (!checked.ok) throw new Error(`karst draft propose: ${checked.reason}`);

  const id = randomUUID();
  const tmp = join(dir, `.tmp-${id}`);
  const file = join(dir, `${id}.json`);
  writeFileSync(tmp, JSON.stringify(checked.value), { flag: 'wx', mode: 0o600 });
  try {
    renameSync(tmp, file);
  } catch (e) {
    unlinkSync(tmp);
    throw e;
  }
  return JSON.stringify({ ok: true, file });
}

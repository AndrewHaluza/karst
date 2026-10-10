import { dirname, join } from 'node:path';

import type { Store } from '../store/db.js';
import { OUTPUT_KINDS } from '../manifest/types.js';
import type { OutputKind } from '../manifest/types.js';
import { addArtifactForTicket } from '../artifacts/forTicket.js';

/**
 * The `karst artifact add <path> --kind <kind>` CLI — captures a file outside
 * the approach `outputs:` globs (e.g. a dev script) into the ticket's artifact
 * store and tracks it for later revisions.
 *
 * Same narrow-argv model as `phase` (a SEPARATE parse path; see phase.ts and
 * arch:CLI-02): the agent reads ticket content it did not author, so prompt
 * injection reaches argv. Exactly `artifact add <path> --kind <kind>`; trailing
 * argv is refused; the kind is re-validated against the fixed list; the path
 * must realpath inside one of the calling ticket's worktrees.
 */
export interface ParsedArtifactAdd {
  path: string;
  kind: OutputKind;
}

export function parseArtifactAddArgs(argv: string[]): ParsedArtifactAdd {
  const [cmd, sub, path, flag, kind, ...extra] = argv;
  if (cmd !== 'artifact') throw new Error(`expected 'artifact' command, got '${cmd ?? ''}'`);
  if (sub !== 'add') throw new Error("expected 'artifact add <path> --kind <kind>'");
  if (path === undefined || path === '' || path.startsWith('--') || path.includes('\0')) {
    throw new Error('missing or invalid path (want `artifact add <path> --kind <kind>`)');
  }
  if (flag !== '--kind' || kind === undefined) {
    throw new Error('missing --kind <kind> (want `artifact add <path> --kind <kind>`)');
  }
  if (!(OUTPUT_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`unknown kind '${kind}' (want one of: ${OUTPUT_KINDS.join(', ')})`);
  }
  if (extra.length > 0) {
    throw new Error(
      `unexpected argument '${extra[0]}' — artifact add takes a path and --kind only ` +
        '(source, session and timestamps are recorded server-side)',
    );
  }
  return { path, kind: kind as OutputKind };
}

/** Parse argv and capture the file for `ticketId`; returns a one-line confirmation. */
export async function runArtifactAddCommand(
  store: Store,
  ticketId: number,
  dbPath: string,
  argv: string[],
): Promise<string> {
  const { path, kind } = parseArtifactAddArgs(argv);
  const res = await addArtifactForTicket(store, join(dirname(dbPath), 'artifacts'), ticketId, path, kind);
  return `artifact added: ${res.repo}/${res.relPath} (${kind})`;
}

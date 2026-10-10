import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { OUTPUT_KINDS } from '../manifest/types.js';
import type { OutputKind } from '../manifest/types.js';

/** A file outside the outputs globs that the ticket explicitly added to its artifacts. */
export interface TrackedEntry {
  repo: string;
  /** Path relative to the repository root, `/`-separated. */
  relPath: string;
  kind: OutputKind;
}

const FILE = 'tracked.json';

const isEntry = (v: unknown): v is TrackedEntry => {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.repo === 'string' &&
    typeof e.relPath === 'string' &&
    typeof e.kind === 'string' &&
    (OUTPUT_KINDS as readonly string[]).includes(e.kind)
  );
};

/** The ticket's explicitly-added paths; empty when none were added or the file is unreadable. */
export function readTracked(ticketDir: string): TrackedEntry[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(ticketDir, FILE), 'utf8'));
    return Array.isArray(raw) ? raw.filter(isEntry) : [];
  } catch {
    return [];
  }
}

/**
 * Add (or re-kind) one entry and persist atomically. Callers run inside the
 * store's per-ticket queue so read-modify-write cannot interleave.
 */
export function addTracked(ticketDir: string, entry: TrackedEntry): TrackedEntry[] {
  const next = [
    ...readTracked(ticketDir).filter((e) => !(e.repo === entry.repo && e.relPath === entry.relPath)),
    entry,
  ];
  mkdirSync(ticketDir, { recursive: true });
  const tmp = join(ticketDir, `${FILE}.tmp`);
  writeFileSync(tmp, JSON.stringify(next));
  renameSync(tmp, join(ticketDir, FILE));
  return next;
}

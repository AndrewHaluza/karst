// npm run eval:form:export -- --db <karst.db> --sample 20 --seed 1 -> evals/form/local/own-tickets.jsonl
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTicketRows, rowsToCases, sampleRows } from './inputs.mjs';
import { readDraftRows } from './draftInputs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const OWN_TICKETS_PATH = resolve(ROOT, 'evals/form/local/own-tickets.jsonl');

export function parseExportArgs(argv) {
  const o = { db: null, sample: 20, seed: 1, pass: 'intent-own', project: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === '--db') { o.db = v; i++; } else if (a === '--sample') { o.sample = Number(v); i++; } else if (a === '--seed') { o.seed = Number(v); i++; } else if (a === '--pass') { o.pass = v; i++; } else if (a === '--project') { o.project = v; i++; } else throw new Error(`unknown flag ${a}`);
  }
  if (!['intent-own', 'draft'].includes(o.pass)) throw new Error('--pass must be draft (or omitted for own tickets)');
  if (!o.db) throw new Error('--db <karst.db> is required');
  if (!Number.isInteger(o.sample) || o.sample < 1) throw new Error('--sample must be a positive integer');
  if (!Number.isInteger(o.seed)) throw new Error('--seed must be an integer');
  return o;
}

export const DRAFTS_PATH = resolve(ROOT, 'evals/form/local/drafts.jsonl');

/** Deterministic sample of accepted drafts with a merged PR sha -> drafts.jsonl (private, gitignored). */
export function exportDrafts(argv, out = DRAFTS_PATH) {
  const { db, sample, seed, project } = parseExportArgs(argv);
  const rows = sampleRows(readDraftRows(db, project), sample, seed);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, rows.map((c) => JSON.stringify(c)).join('\n') + (rows.length ? '\n' : ''));
  return { out, count: rows.length };
}

export function exportOwnTickets(argv, out = OWN_TICKETS_PATH) {
  const { db, sample, seed } = parseExportArgs(argv);
  const cases = rowsToCases(sampleRows(readTicketRows(db), sample, seed));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, cases.map((c) => JSON.stringify(c)).join('\n') + (cases.length ? '\n' : ''));
  return { out, count: cases.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    const { out, count } = argv.includes('draft') ? exportDrafts(argv) : exportOwnTickets(argv);
    console.log(`wrote ${count} tickets to ${out}`);
  } catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }
}

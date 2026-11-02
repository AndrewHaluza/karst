// npm run eval:form:export -- --db <karst.db> --sample 20 --seed 1 -> evals/form/local/own-tickets.jsonl
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTicketRows, rowsToCases, sampleRows } from './inputs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const OWN_TICKETS_PATH = resolve(ROOT, 'evals/form/local/own-tickets.jsonl');

export function parseExportArgs(argv) {
  const o = { db: null, sample: 20, seed: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === '--db') { o.db = v; i++; } else if (a === '--sample') { o.sample = Number(v); i++; } else if (a === '--seed') { o.seed = Number(v); i++; } else throw new Error(`unknown flag ${a}`);
  }
  if (!o.db) throw new Error('--db <karst.db> is required');
  if (!Number.isInteger(o.sample) || o.sample < 1) throw new Error('--sample must be a positive integer');
  if (!Number.isInteger(o.seed)) throw new Error('--seed must be an integer');
  return o;
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
    const { out, count } = exportOwnTickets(process.argv.slice(2));
    console.log(`wrote ${count} tickets to ${out}`);
  } catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }
}

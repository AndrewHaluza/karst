// Input loading: handwritten cases, own-ticket sampler, prompt sources.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { extractVerbatimTokens } from './checks.mjs';

export const MIN_BRIEF_LENGTH = 200;

export function parseJsonl(text, label = 'jsonl') {
  return text.split('\n').filter((l) => l.trim()).map((l, i) => {
    try { return JSON.parse(l); } catch { throw new Error(`${label}: line ${i + 1} is not valid JSON`); }
  });
}

function validateCase(c, label) {
  for (const k of ['id', 'title', 'type', 'input']) if (typeof c[k] !== 'string' || !c[k]) throw new Error(`${label}: case missing "${k}"`);
  if (!c.expect || !Array.isArray(c.expect.verbatim)) throw new Error(`${label}: case ${c.id} needs expect.verbatim[]`);
  return c;
}

/** kind 'case' runs in an empty temp dir; 'own' runs in the project root. */
export function loadCases(path, kind = 'case') {
  return parseJsonl(readFileSync(path, 'utf8'), path).map((c) => ({ ...validateCase(c, path), kind }));
}

/** Small deterministic PRNG (mulberry32). */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic sample: order by id, seeded Fisher-Yates, take n, return in id order. */
export function sampleRows(rows, n, seed) {
  const sorted = [...rows].sort((a, b) => a.id - b.id);
  const rnd = prng(seed);
  for (let i = sorted.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
  }
  return sorted.slice(0, n).sort((a, b) => a.id - b.id);
}

/** Read-only pull of eligible tickets. The stored `description` is deliberately NOT read. */
export function readTicketRows(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(
      `SELECT id, title, type, brief FROM tickets
       WHERE source IN ('manual', 'planning') AND brief IS NOT NULL AND length(brief) > ?`,
    ).all(MIN_BRIEF_LENGTH);
  } finally { db.close(); }
}

export function rowsToCases(rows) {
  return rows.map((r) => ({
    id: `own-${r.id}`, title: r.title ?? '', type: r.type || 'feat', input: r.brief,
    expect: { verbatim: extractVerbatimTokens(r.brief) },
  }));
}

/** Frontmatter-stripped body of an agent .md, like readAgentFile consumers use. Plain md passes through. */
export function stripFrontmatter(text) {
  if (!text.startsWith('---')) return text;
  const lines = text.split('\n');
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  return close < 0 ? text : lines.slice(close + 1).join('\n').replace(/^\n+/, '');
}

/** `builtin` -> {name:'builtin', body:null}; a path -> {name: basename, body}. */
export function loadPromptSource(spec, read = (p) => readFileSync(p, 'utf8')) {
  if (spec === 'builtin') return { name: 'builtin', body: null };
  const body = stripFrontmatter(read(spec)).trim();
  if (!body) throw new Error(`prompt file ${spec} has an empty body`);
  return { name: basename(spec), body };
}

// Shared issue scope for the intent pass: a majority vote of judges, saved in one file.
// With a scope file, all judges and all charters of a case use one denominator.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeIssueScope } from './intentJudge.mjs';

const SCOPE_ATTEMPTS = 2;

/** A test is stated when more than half of the votes state it. */
export function majorityScope(votes, names) {
  const stated = names.filter((n) => votes.filter((v) => v.stated.includes(n)).length * 2 > votes.length);
  return { stated, notStated: names.filter((n) => !stated.includes(n)) };
}

/** Each intent case with tests, once. The first entry of a case gives its issue and its tests. */
export function scopeCases(entries) {
  const cases = new Map();
  for (const e of entries) {
    if (e.pass === 'intent' && !e.skip && e.tests.length > 0 && !cases.has(e.caseId)) cases.set(e.caseId, { caseId: e.caseId, issue: e.source_text, tests: e.tests });
  }
  return [...cases.values()];
}

async function askJudge({ adapter, judge, item, effort, makeEmptyDir }) {
  let scope;
  for (let i = 0; i < SCOPE_ATTEMPTS && !scope?.ok; i++) {
    const cwd = makeEmptyDir();
    try {
      scope = await judgeIssueScope(adapter, { issue: item.issue, tests: item.tests, model: judge, cwd, effort });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  }
  return scope;
}

/** Ask each judge about each case, sequentially. A case with a failed judge gets no scope and is listed in `failed`. */
export async function buildIssueScopes({ cases, judges, adapters, effort, makeEmptyDir = () => mkdtempSync(join(tmpdir(), 'eval-scope-')), onProgress = () => {} }) {
  const scoped = {};
  const failed = [];
  for (const item of cases) {
    const votes = [];
    for (const [j, judge] of judges.entries()) {
      const scope = await askJudge({ adapter: adapters[j], judge, item, effort, makeEmptyDir });
      if (scope.ok) votes.push({ judge, stated: scope.stated });
      else failed.push({ caseId: item.caseId, judge, error: scope.error });
      onProgress(item.caseId, judge);
    }
    if (votes.length === judges.length) scoped[item.caseId] = { ...majorityScope(votes, item.tests.map((t) => t.test)), votes };
  }
  return { cases: scoped, failed };
}

const isNames = (x) => Array.isArray(x) && x.every((n) => typeof n === 'string');

/** Validate a parsed scope file. Returns Map(caseId -> {stated, notStated}). */
export function parseIssueScopes(file) {
  const cases = file?.cases;
  if (!cases || typeof cases !== 'object' || Array.isArray(cases)) throw new Error('scope file: "cases" must be an object');
  for (const [id, c] of Object.entries(cases)) {
    if (!isNames(c?.stated) || !isNames(c?.notStated)) throw new Error(`scope file: wrong shape for case ${id}`);
  }
  return new Map(Object.entries(cases));
}

export function loadIssueScopes(path) {
  if (!existsSync(path)) throw new Error(`scope file not found: ${path}`);
  let file;
  try { file = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { throw new Error(`scope file: invalid JSON in ${path}: ${e instanceof Error ? e.message : String(e)}`); }
  return parseIssueScopes(file);
}

/** The saved scope of a case. A missing case or an unknown test is a judge-error, never a silent not-in-issue. */
export function fixedScope(scopes, caseId, tests) {
  if (tests.length === 0) return { ok: true, stated: [], notStated: [] };
  const saved = scopes.get(caseId);
  if (!saved) return { ok: false, error: `judge-error: issue scope: no scope for case ${caseId}` };
  const unknown = tests.find((t) => !saved.stated.includes(t.test) && !saved.notStated.includes(t.test));
  if (unknown) return { ok: false, error: `judge-error: issue scope: test not in scope: ${unknown.test}` };
  return { ok: true, stated: saved.stated, notStated: saved.notStated };
}

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { DIFF_HUNK_BUDGET_CHARS, archKeys, buildDiff, changedFiles, gitRunner, resolveCommits, staticChecks } from './draftChecks.mjs';
import { extractIdRefs, readDraftRows, sampleDrafts } from './draftInputs.mjs';
import { buildDraftJudgePrompt, judgeDraft, parseDraftJudge } from './draftJudge.mjs';
import { renderDraftReport, summarizeDrafts } from './draftReport.mjs';
import { runDraftEval } from './draftRun.mjs';
import { exportDrafts, parseExportArgs } from './export.mjs';
import { parseArgs } from './run.mjs';

const tmps = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'evaldraft-')); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Temp repo: base has docs/arch/a.md + src/old.ts; the "merge" commit edits old.ts, adds new.ts and a lockfile. */
function makeRepo() {
  const dir = tmp();
  const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'docs/arch'), { recursive: true }); mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'docs/arch/a.md'), '## [@arch:REAL] Real\nbody\nEND_DOC_BLOCK: [@arch:REAL]\n');
  writeFileSync(join(dir, 'src/old.ts'), 'a\n');
  g('add', '.'); g('commit', '-qm', 'base');
  const base = g('rev-parse', 'HEAD').trim();
  writeFileSync(join(dir, 'src/old.ts'), 'a\nb\n'); writeFileSync(join(dir, 'src/new.ts'), 'n\n'); writeFileSync(join(dir, 'package-lock.json'), '{}\n');
  g('add', '.'); g('commit', '-qm', 'feat');
  return { dir, git: gitRunner(dir), base, sha: g('rev-parse', 'HEAD').trim() };
}
const SUMMARY = '## Decisions\nedit src/old.ts and add src/new.ts\n## Rejected\nnone';

describe('draft static checks', () => {
  it('resolves commits and flags a missing sha', () => {
    const r = makeRepo();
    expect(resolveCommits(r.git, r.sha)).toEqual({ sha: r.sha, parent: r.base });
    expect(resolveCommits(r.git, 'deadbeefdeadbeef')).toBeNull();
    expect(resolveCommits(r.git, 'not-a-sha')).toBeNull();
  });
  it('clean draft has no defects; created paths count as existing', () => {
    const r = makeRepo(); const c = resolveCommits(r.git, r.sha); const files = changedFiles(r.git, c);
    const payload = { summary: SUMMARY, constraints: ['@arch:REAL', r.base.slice(0, 10), 'T5'] };
    expect(staticChecks({ git: r.git, commits: c, files, payload, refs: { T5: true }, docKeys: archKeys(r.git, c.parent) })).toEqual([]);
  });
  it('reports each kind: arch key, commit, id ref, path, shape', () => {
    const r = makeRepo(); const c = resolveCommits(r.git, r.sha); const files = changedFiles(r.git, c);
    const payload = { summary: 'touch src/ghost.ts', constraints: ['@arch:NOPE', 'abcdef1234567', 'D99'] };
    const d = staticChecks({ git: r.git, commits: c, files, payload, refs: { D99: false }, docKeys: archKeys(r.git, c.parent) });
    expect(d.map((x) => x.kind).sort()).toEqual(['arch-key', 'commit', 'id-ref', 'path', 'shape', 'shape']);
  });
});

describe('diff budget', () => {
  it('drops lockfiles, keeps the file list, truncates over budget and records it', () => {
    const r = makeRepo(); const c = resolveCommits(r.git, r.sha); const files = changedFiles(r.git, c);
    expect(files.map((f) => f.path).sort()).toEqual(['package-lock.json', 'src/new.ts', 'src/old.ts']);
    const full = buildDiff(r.git, c, files);
    expect(full.dropped).toEqual(['package-lock.json']);
    expect(full.text).toContain('src/new.ts');
    expect(full.text).not.toContain('package-lock');
    expect(full.wasTruncated).toBe(true);
    const tiny = buildDiff(r.git, c, files, 10);
    expect(tiny.truncated.sort()).toEqual(['src/new.ts', 'src/old.ts']);
    expect(DIFF_HUNK_BUDGET_CHARS).toBeGreaterThan(1000);
  });
});

describe('judge', () => {
  const good = JSON.stringify({ notDone: [{ item: 'x', draftQuote: 'q' }], unrequested: [], reviewFix: [{ change: 'c', file: 'f' }], verdict: 'partial' });
  it('parses fenced output; reviewFix optional; bad shape/verdict is judge-error', () => {
    expect(parseDraftJudge('```json\n' + good + '\n```').ok).toBe(true);
    expect(parseDraftJudge('{"notDone":[],"unrequested":[],"verdict":"matches"}')).toMatchObject({ ok: true, reviewFix: [] });
    expect(parseDraftJudge('{"notDone":[],"unrequested":[],"verdict":"great"}').ok).toBe(false);
    expect(parseDraftJudge('nope').error).toMatch(/judge-error/);
  });
  it('prompt carries draft + files + diff; adapter failure never throws', async () => {
    const p = buildDraftJudgePrompt({ draft: { title: 'T', constraints: ['c1'] }, files: [{ status: 'A', path: 'a.ts' }], diff: 'DIFFTEXT' });
    expect(p).toContain('Title: T'); expect(p).toContain('A\ta.ts'); expect(p).toContain('DIFFTEXT');
    expect(await judgeDraft({ runHeadless: async () => { throw new Error('down'); } }, { draft: {}, files: [], diff: '', model: 'm', cwd: '/x' })).toEqual({ ok: false, error: 'judge-error: down' });
  });
});

function seedDb() {
  const path = join(tmp(), 'k.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY, slug TEXT);
    CREATE TABLE tickets (id INTEGER PRIMARY KEY, key TEXT);
    CREATE TABLE prs (ticket_id INTEGER, repo TEXT, merged_at TEXT, merge_sha TEXT, base_ref TEXT);
    CREATE TABLE planning_sessions (id INTEGER PRIMARY KEY, project_id INTEGER, core TEXT, model TEXT);
    CREATE TABLE planning_proposals (id INTEGER PRIMARY KEY, session_id INTEGER, payload_json TEXT, depends_on TEXT, status TEXT, ticket_id INTEGER);
    INSERT INTO projects VALUES (1,'a'),(2,'b');
    INSERT INTO planning_sessions VALUES (1,1,'claude','opus'),(2,2,'codex',NULL);`);
  const add = (id, sess, status, ticket, sha, constraints = []) => {
    if (ticket) { db.prepare('INSERT INTO tickets VALUES (?,?)').run(ticket, `K-${ticket}`); if (sha) db.prepare('INSERT INTO prs VALUES (?,?,?,?,?)').run(ticket, 'r', '2026-01-01', sha, 'develop'); }
    db.prepare('INSERT INTO planning_proposals VALUES (?,?,?,?,?,?)').run(id, sess, JSON.stringify({ title: `t${id}`, summary: 's', constraints }), '[]', status, ticket);
  };
  add(1, 1, 'accepted', 10, 'sha1', ['T10', 'D404']);
  add(2, 1, 'accepted', 11, 'sha2');
  add(3, 1, 'pending', null, null);
  add(4, 1, 'accepted', 12, null);
  add(5, 2, 'accepted', 13, 'sha5');
  db.close();
  return path;
}

describe('export', () => {
  it('selects accepted + merged sha only, records ref existence, filters by project, deterministic sample', () => {
    const path = seedDb();
    const rows = readDraftRows(path);
    expect(rows.map((r) => r.id)).toEqual([1, 2, 5]);
    expect(rows[0]).toMatchObject({ ticketKey: 'K-10', repo: 'r', mergeSha: 'sha1', baseRef: 'develop', core: 'claude', refs: { T10: true, D404: false } });
    expect(readDraftRows(path, 'b').map((r) => r.id)).toEqual([5]);
    expect(sampleDrafts(rows, 2, 7).map((r) => r.id)).toEqual(sampleDrafts(rows, 2, 7).map((r) => r.id));
    const out = join(tmp(), 'd.jsonl');
    expect(exportDrafts(['--pass', 'draft', '--db', path, '--sample', '2', '--seed', '1'], out).count).toBe(2);
  });
  it('parses args', () => {
    expect(parseExportArgs(['--pass', 'draft', '--db', 'x', '--project', 'p'])).toMatchObject({ pass: 'draft', project: 'p' });
    expect(() => parseExportArgs(['--pass', 'bad', '--db', 'x'])).toThrow(/--pass/);
    expect(extractIdRefs('see T5, D6 and T5')).toEqual(['T5', 'D6']);
  });
});

describe('run + report', () => {
  const mkRow = (r, id, over = {}) => ({ id, ticketId: id, ticketKey: `K${id}`, payload: { title: `t${id}`, summary: SUMMARY, constraints: [] }, core: 'claude', model: 'opus', repo: 'r', mergeSha: r.sha, refs: {}, ...over });
  const judgeJson = JSON.stringify({ notDone: [{ item: 'missing', draftQuote: 'q' }], unrequested: [{ change: 'extra', file: 'src/x.ts', why: 'w' }], reviewFix: [], verdict: 'diverges' });
  it('flags unavailable cases, scores the rest, excludes judge-errors, joins outcomes, marks LOW', async () => {
    const r = makeRepo();
    const calls = [];
    const adapter = { runHeadless: async (o) => { calls.push(o); return { raw: calls.length === 2 ? 'garbage' : judgeJson }; } };
    const rows = [mkRow(r, 1), mkRow(r, 2), mkRow(r, 3, { mergeSha: 'deadbeefdeadbeef' }), mkRow(r, 4, { repo: 'nope' }), mkRow(r, 5, { model: 'judge' })];
    const results = await runDraftEval({ opts: { judgeModel: 'judge' }, rows, gitFor: (repo) => (repo === 'r' ? r.git : null), judgeAdapter: adapter, cwd: tmp() });
    expect(results.map((x) => x.unavailable ?? (x.judge?.ok ? 'scored' : 'judge-error'))).toEqual(['scored', 'judge-error', 'missing-commit', 'missing-repo', 'judge-wrote-draft']);
    expect(calls).toHaveLength(2);
    const s = summarizeDrafts(results);
    expect(s).toMatchObject({ total: 5, unavailable: 3, judgeErrors: 1, scored: 1, notDonePerDraft: 1, unrequestedPerDraft: 1, truncated: 2 });
    const outcomes = new Map([[1, { reworkRounds: 2, reviewFindings: 3, fixRounds: 1, medianHoursToMerge: 4.5 }]]);
    const md = renderDraftReport({ meta: { provider: 'claude', judgeModel: 'judge', startedAt: 'now' }, results, outcomes });
    expect(md).toContain('unavailable(missing-commit)');
    expect(md).toContain('claude/opus LOW');
    expect(md).toContain('2.0 / 3.0 / 1.0 / 4.5');
    expect(md).toContain('pending / pending / pending / pending');
  });
  it('--pass draft arg rules', () => {
    expect(parseArgs(['--pass', 'draft', '--judge-model', 'j', '--db', 'x', '--repo', 'r=/p']).repos).toEqual({ r: '/p' });
    expect(() => parseArgs(['--pass', 'draft', '--judge-model', 'j'])).toThrow(/--db/);
    expect(() => parseArgs(['--pass', 'draft', '--db', 'x'])).toThrow(/judge-model/);
  });
});

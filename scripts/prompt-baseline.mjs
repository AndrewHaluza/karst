import { DatabaseSync } from 'node:sqlite';

const DB = process.argv[2];
const db = new DatabaseSync(DB, { readOnly: true });

const pct = (arr, p) => {
  const s = arr.slice().sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
};
const stats = (arr) => ({
  count: arr.length,
  avg: arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null,
  p50: pct(arr, 0.5),
  p90: pct(arr, 0.9),
  max: arr.length ? Math.max(...arr) : null,
});
const num = (sql, ...p) => {
  try { return db.prepare(sql).all(...p).map((r) => r.n ?? r.v ?? 0); }
  catch (e) { return { error: String(e.message || e) }; };
};
const show = (label, v) => console.log(`${label}:`, JSON.stringify(v));

// -- ticket-text distribution (the already-cited baseline, recomputed whole-store) --
for (const field of ['description', 'brief', 'title']) {
  try {
    const rows = db.prepare(`SELECT ${field} AS v FROM tickets`).all();
    show(`tickets.${field} chars`, stats(rows.map((r) => (typeof r.v === 'string' ? r.v.length : 0))));
  } catch (e) { show(`tickets.${field}`, { error: String(e.message) }); }
}
try {
  show('projects', db.prepare('SELECT COUNT(*) n FROM projects').get().n);
  show('tickets', db.prepare('SELECT COUNT(*) n FROM tickets').get().n);
} catch (e) { show('counts', { error: String(e.message) }); }

// -- marker compliance (session/fix process-run closure) --
try {
  const rows = db.prepare(
    "SELECT status, COUNT(*) n FROM process_runs WHERE process_id IN ('session','fix') GROUP BY status",
  ).all();
  const m = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  const advanced = m.passed ?? 0;
  const silent = (m.interrupted ?? 0) + (m.stale ?? 0);
  show('markerCompliance', { passed: advanced, interrupted: m.interrupted ?? 0, stale: m.stale ?? 0, running: m.running ?? 0, rate: advanced + silent ? advanced / (advanced + silent) : null });
} catch (e) { show('markerCompliance', { error: String(e.message) }); }

// -- fix loop depth (derivable: stages.attempt) --
try {
  const rows = db.prepare("SELECT ticket_id, MAX(attempt) a FROM stages WHERE stage_key='fix' GROUP BY ticket_id").all();
  show('fixLoopDepth (per-ticket max fix attempt)', stats(rows.map((r) => r.a)));
} catch (e) { show('fixLoopDepth', { error: String(e.message) }); }

// -- tokens per passed process run (derivable: token_usage joined to passed process_runs) --
try {
  const rows = db.prepare(`
    SELECT pr.provider p, COALESCE(SUM(t.total_tokens),0) tokens, COUNT(DISTINCT pr.id) passes
      FROM token_usage t JOIN process_runs pr ON pr.id = t.process_run_id
     WHERE pr.status='passed' AND t.estimated=0 AND pr.provider IS NOT NULL
     GROUP BY pr.provider`).all();
  show('tokensPerPassedRun', rows.map((r) => ({ provider: r.p, tokens: r.tokens, passes: r.passes, avgPerPass: r.passes ? Math.round(r.tokens / r.passes) : null })));
} catch (e) { show('tokensPerPassedRun', { error: String(e.message) }); }

// -- wrong-checkout deterministic observations (derivable: uat_findings titles) --
try {
  const r = db.prepare("SELECT COUNT(*) n FROM uat_findings WHERE title LIKE 'UAT skipped: checkout is on%'").get();
  show('wrongCheckout observations', r.n);
} catch (e) { show('wrongCheckout', { error: String(e.message) }); }

// -- process-run mix (context: what evidence exists by process_id/provider) --
try {
  show('process_runs by process_id', db.prepare('SELECT process_id, COUNT(*) n FROM process_runs GROUP BY process_id ORDER BY n DESC').all());
} catch (e) { show('process_runs breakdown', { error: String(e.message) }); }

// -- NEW metrics: expect the column/table to be absent pre-v57 --
show('guide-pull rows (expect 0 pre-instrumentation)', (() => { try { return db.prepare("SELECT COUNT(*) n FROM process_runs WHERE process_id='guide-pull'").get().n; } catch (e) { return { error: String(e.message) }; } })());
show('seedChars telemetry (expect pending pre-v57)', (() => { try { return db.prepare("SELECT COUNT(*) n FROM process_runs WHERE json_extract(prompt_telemetry,'$.seedChars') IS NOT NULL").get().n; } catch (e) { return { error: String(e.message) }; } })());
show('findings parseTiers telemetry (expect pending)', (() => { try { return db.prepare("SELECT COUNT(*) n FROM process_runs WHERE json_extract(prompt_telemetry,'$.parseTiers') IS NOT NULL").get().n; } catch (e) { return { error: String(e.message) }; } })());
show('tester nudge telemetry (expect pending)', (() => { try { return db.prepare("SELECT COUNT(*) n FROM process_runs WHERE json_extract(prompt_telemetry,'$.silenceNudges') IS NOT NULL").get().n; } catch (e) { return { error: String(e.message) }; } })());

db.close();

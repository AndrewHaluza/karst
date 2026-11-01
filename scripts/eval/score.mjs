// Scoring on the HOST, after the container run, on the collected predictions file, with the official
// harness of the set. The UAT container never gets the Docker socket (that would hand the agent host
// root and break @arch:UATHOST-02); the harness's resolved verdict (F2P flipped AND P2P kept) is the score.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConfig, classifyReport } from '../evalCheckSet.mjs';

/**
 * Multi-SWE-bench: one harness invocation over a predictions file. Returns Map(harnessId → verdict)
 * where verdict is 'resolved' | 'unresolved' | 'error'. Empty patches are unresolved without a run
 * (the harness rejects an empty file and would report an error, which is not an agent failure to hide).
 */
export function scoreMultiSweBench({ rows, predictionsPath, python, harnessId, run = spawnSync }) {
  const verdicts = new Map();
  const predictions = readFileSync(predictionsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const runnable = predictions.filter((p) => typeof p.fix_patch === 'string' && p.fix_patch.trim() !== '');
  for (const p of predictions) if (!runnable.includes(p)) verdicts.set(`${p.org}/${p.repo}:pr-${p.number}`, 'unresolved');
  if (runnable.length === 0) return verdicts;
  const ids = new Set(runnable.map((p) => `${p.org}/${p.repo}:pr-${p.number}`));
  const dir = mkdtempSync(join(tmpdir(), 'eval-score-'));
  try {
    for (const d of ['work', 'out', 'logs', 'repos']) mkdirSync(join(dir, d));
    writeFileSync(join(dir, 'dataset.jsonl'), rows.filter((r) => ids.has(harnessId(r))).map((r) => `${JSON.stringify(r)}\n`).join(''));
    writeFileSync(join(dir, 'patch.jsonl'), runnable.map((p) => `${JSON.stringify(p)}\n`).join(''));
    // stop_on_error stays false: one instance's harness error must not discard the others' verdicts.
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...buildConfig(dir), stop_on_error: false }));
    const r = run(python, ['-m', 'multi_swe_bench.harness.run_evaluation', '--config', join(dir, 'config.json')], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const reportFile = join(dir, 'out', 'final_report.json');
    const report = r.status === 0 && existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : null;
    for (const id of ids) verdicts.set(id, report ? classifyReport(report, id) : 'error');
    return verdicts;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** SWE-PolyBench's harness is not provisioned by `eval:setup` (the pinned set is Multi-SWE-bench). */
export function scoreSwePolyBench() {
  throw new Error('scoring swe-polybench needs its harness (amazon-science/SWE-PolyBench), which `npm run eval:setup` does not install; only the normalizer and prediction writer are wired');
}

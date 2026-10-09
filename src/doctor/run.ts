import { applyFixes, type FixEffects } from './applyFixes.js';
import {
  DOCTOR_AREAS,
  type AppliedFix,
  type DoctorArea,
  type DoctorCheck,
  type DoctorReport,
} from './types.js';

export interface RunDoctorOptions {
  areas?: readonly DoctorArea[];
  fix: boolean;
  /** Gathers probes and runs the pure checks for the given areas (read-only). */
  collect: (areas: readonly DoctorArea[]) => DoctorCheck[];
  /** Only touched when `fix` is true. */
  effects: FixEffects;
}

export function summarize(checks: readonly DoctorCheck[]): DoctorReport['summary'] {
  const s = { ok: 0, warn: 0, fail: 0 };
  for (const c of checks) s[c.status] += 1;
  return s;
}

/**
 * Read-only unless `fix`. With `fix`, auto fixes run once, then the checks are
 * re-collected so the report (and exit code) reflects the state AFTER fixing.
 */
export function runDoctor(opts: RunDoctorOptions): DoctorReport {
  const areas = opts.areas && opts.areas.length > 0 ? [...opts.areas] : [...DOCTOR_AREAS];
  let checks = opts.collect(areas);
  let applied: AppliedFix[] = [];
  if (opts.fix) {
    applied = applyFixes(checks, opts.effects);
    if (applied.some((a) => a.ok)) checks = opts.collect(areas);
  }
  const summary = summarize(checks);
  return {
    areas,
    fixRequested: opts.fix,
    checks,
    applied,
    summary,
    exitCode: summary.fail > 0 ? 1 : 0,
  };
}

export function parseDoctorArea(value: string): DoctorArea {
  if ((DOCTOR_AREAS as readonly string[]).includes(value)) return value as DoctorArea;
  throw new Error(`karst doctor: --area wants one of ${DOCTOR_AREAS.join('|')} (got '${value}')`);
}

const MARK = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' } as const;

/** Human rendering: one line per check, fix hint beneath, applied fixes last. */
export function renderDoctorText(r: DoctorReport): string {
  const lines: string[] = [];
  for (const c of r.checks) {
    lines.push(`[${MARK[c.status]}] ${c.id} — ${c.detail}`);
    if (c.fix && c.status !== 'ok') {
      const step = c.fix.tier === 'auto' ? 'run with --fix' : c.fix.tier === 'consented' ? c.fix.command : c.fix.nextStep;
      lines.push(`       ${c.fix.tier}: ${c.fix.summary} → ${step}`);
    }
  }
  for (const a of r.applied) lines.push(`fixed${a.ok ? '' : ' (skipped)'}: ${a.what} — ${a.why} [${a.evidence}]`);
  lines.push(`${r.summary.ok} ok, ${r.summary.warn} warn, ${r.summary.fail} fail`);
  return lines.join('\n');
}

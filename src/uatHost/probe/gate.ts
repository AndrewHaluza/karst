export const PROBE_ENV = 'KARST_UAT_PROBE';
export const PROBE_COMMAND = 'karst.uatProbe.run';

/** The probe exists only when the harness opts in; normal activation never sees it. */
export function probeEnabled(env: Record<string, string | undefined>): boolean {
  return env[PROBE_ENV] === '1';
}

import type { ProcessResult } from './sbx/sbxProcess.js';

/** One resource a sandbox removal touched: `absent` (already gone) counts as success, `failed` does not. */
export interface DisposeStep {
  readonly step: string;
  readonly status: 'removed' | 'absent' | 'failed';
  readonly stderr?: string;
}

export interface DisposeResult {
  readonly ok: boolean;
  readonly steps: readonly DisposeStep[];
}

const GONE = /no such|not found|does not exist|unknown sandbox/i;

/** Maps one removal command's exit to a step: 0 removed, 'no such …' absent, anything else failed with its stderr. */
export function disposeStep(step: string, out: Pick<ProcessResult, 'code' | 'stderr'>): DisposeStep {
  if (out.code === 0) return { step, status: 'removed' };
  const stderr = out.stderr.trim() || `exited ${out.code}`;
  return { step, status: GONE.test(stderr) ? 'absent' : 'failed', stderr };
}

export function disposeResult(steps: readonly DisposeStep[]): DisposeResult {
  return { ok: steps.every((s) => s.status !== 'failed'), steps };
}

/** `step: stderr` for every failed step, for logs and the ticket-facing message. */
export function disposeFailures(result: DisposeResult): string {
  return result.steps.filter((s) => s.status === 'failed').map((s) => `${s.step}: ${s.stderr ?? 'failed'}`).join('; ');
}

import { connect } from 'node:net';
import type { UiStep } from './steps.js';

/** What the driver saw around one UI step (arch:UATHOST-02). Paths are relative to `--out`. */
export interface UiEvidence {
  screenshot: string | null;
  visibleActs: string[];
  textAdded: string[];
  textRemoved: string[];
  /** Toast texts cleared before a `click`. Absent for other steps. */
  toasts?: string[];
}
export interface UiOutcome {
  status: 'pass' | 'fail' | 'timeout';
  detail?: string;
  ui?: UiEvidence;
}
export interface UiDriver {
  run(index: number, step: UiStep, timeoutMs: number): Promise<UiOutcome>;
}

/** The driver needs time after the step deadline for the screenshot and the text read. */
export const UI_GRACE_MS = 15_000;
const CONNECT_RETRY_MS = 100;

const isOutcome = (v: unknown): v is UiOutcome =>
  typeof v === 'object' && v !== null && ['pass', 'fail', 'timeout'].includes((v as { status?: unknown }).status as string);

/** One connection per step: connect (the driver may still be starting), send one JSON line, read one JSON line. */
function request(socketPath: string, body: unknown, connectDeadline: number): Promise<UiOutcome> {
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      const sock = connect(socketPath);
      let buf = '';
      let retrying = false;
      sock.setEncoding('utf8');
      sock.once('connect', () => sock.write(`${JSON.stringify(body)}\n`));
      sock.on('data', (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        sock.destroy();
        try {
          const parsed: unknown = JSON.parse(buf.slice(0, nl));
          if (isOutcome(parsed)) resolve(parsed);
          else reject(new Error('ui driver sent an unreadable reply'));
        } catch (err) {
          reject(new Error(`ui driver sent invalid JSON: ${err instanceof Error ? err.message : String(err)}`));
        }
      });
      sock.once('error', (err: NodeJS.ErrnoException) => {
        const notYet = err.code === 'ENOENT' || err.code === 'ECONNREFUSED';
        if (notYet && Date.now() < connectDeadline) { retrying = true; setTimeout(attempt, CONNECT_RETRY_MS); }
        else reject(new Error(`ui driver unreachable at ${socketPath}: ${err.message}`));
      });
      sock.once('close', () => { if (!retrying && buf.indexOf('\n') < 0) reject(new Error('ui driver closed the channel before it replied')); });
    };
    attempt();
  });
}

/** Client for the Playwright driver process that `run.mjs` starts. Pure node:net: no Playwright in the host. */
export function createUiClient(socketPath: string): UiDriver {
  return {
    run: (index, step, timeoutMs) => request(socketPath, { index, step, timeoutMs }, Date.now() + timeoutMs),
  };
}

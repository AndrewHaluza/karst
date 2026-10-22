export type WaitCondition =
  | { ticketStage: { key: string; stage: string } }
  | { notification: string }
  | { log: string }
  | { webviewMessage: string };

export type Step =
  | { type: 'command'; command: string; args?: unknown[]; timeoutMs?: number }
  | { type: 'wait'; for: WaitCondition; timeoutMs?: number }
  | { type: 'snapshot'; label?: string }
  /** Deactivate + activate the extension in the same host, so boot sweeps run against the seeded state. */
  | { type: 'restart'; timeoutMs?: number };

export const DEFAULT_STEP_TIMEOUT_MS = 10_000;
export const MAX_STEP_TIMEOUT_MS = 60_000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseCondition(v: unknown, at: string): WaitCondition {
  if (!isObj(v)) throw new Error(`${at}: "for" must be an object`);
  const keys = Object.keys(v);
  if (keys.length !== 1) throw new Error(`${at}: "for" must have exactly one condition`);
  const k = keys[0]!;
  const val = v[k];
  if (k === 'ticketStage') {
    if (!isObj(val) || typeof val['key'] !== 'string' || typeof val['stage'] !== 'string') {
      throw new Error(`${at}: ticketStage needs string key and stage`);
    }
    return { ticketStage: { key: val['key'], stage: val['stage'] } };
  }
  if (k === 'notification' || k === 'log' || k === 'webviewMessage') {
    if (typeof val !== 'string' || val === '') throw new Error(`${at}: ${k} needs a non-empty string`);
    return { [k]: val } as WaitCondition;
  }
  throw new Error(`${at}: unknown wait condition "${k}"`);
}

function parseTimeout(raw: Record<string, unknown>, at: string): number | undefined {
  const t = raw['timeoutMs'];
  if (t === undefined) return undefined;
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) throw new Error(`${at}: timeoutMs must be a positive number`);
  return Math.min(t, MAX_STEP_TIMEOUT_MS);
}

/** Steps are data, never code: every field is validated and unknown step types are refused. */
export function parseSteps(json: unknown): Step[] {
  const list = isObj(json) ? json['steps'] : json;
  if (!Array.isArray(list) || list.length === 0) throw new Error('steps file must hold a non-empty steps array');
  return list.map((raw, i): Step => {
    const at = `step ${i}`;
    if (!isObj(raw)) throw new Error(`${at}: must be an object`);
    const timeoutMs = parseTimeout(raw, at);
    const withTimeout = timeoutMs === undefined ? {} : { timeoutMs };
    switch (raw['type']) {
      case 'command': {
        if (typeof raw['command'] !== 'string' || raw['command'] === '') throw new Error(`${at}: command needs a name`);
        const args = raw['args'];
        if (args !== undefined && !Array.isArray(args)) throw new Error(`${at}: args must be an array`);
        return { type: 'command', command: raw['command'], ...(args ? { args } : {}), ...withTimeout };
      }
      case 'wait':
        return { type: 'wait', for: parseCondition(raw['for'], at), ...withTimeout };
      case 'snapshot':
        return { type: 'snapshot', ...(typeof raw['label'] === 'string' ? { label: raw['label'] } : {}) };
      case 'restart':
        return { type: 'restart', ...withTimeout };
      default:
        throw new Error(`${at}: unknown step type "${String(raw['type'])}"`);
    }
  });
}

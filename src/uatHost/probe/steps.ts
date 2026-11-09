export type WaitCondition =
  | { ticketStage: { key: string; stage: string } }
  /** The ticket entered `ship` (eval terminal point) or its current stage is blocked: nothing more will happen unattended. */
  | { ticketSettled: { key: string } }
  | { notification: string }
  | { log: string }
  | { webviewMessage: string }
  | { launch: { provider?: string } };

/** `webview` is the Karst panel (the `vscode-webview` frames); `workbench` is the VS Code window itself (native prompts). */
export type UiSurface = 'webview' | 'workbench';
export type UiClickTarget =
  | { act: string }
  | { quickPick: string }
  | { selector: string; surface: UiSurface };
export type UiTypeTarget = { quickInput: true } | { selector: string; surface: UiSurface };

export type Step =
  | { type: 'command'; command: string; args?: unknown[]; timeoutMs?: number }
  | { type: 'wait'; for: WaitCondition; timeoutMs?: number }
  | { type: 'snapshot'; label?: string }
  /** Deactivate + activate the extension in the same host, so boot sweeps run against the seeded state. */
  | { type: 'restart'; timeoutMs?: number }
  /** UI steps: driven by the Playwright process over CDP (arch:UATHOST-02). Only a script with one opens the CDP port. */
  | { type: 'click'; target: UiClickTarget; timeoutMs?: number }
  | { type: 'type'; text: string; target: UiTypeTarget; submit?: boolean; timeoutMs?: number }
  | { type: 'press'; key: string; timeoutMs?: number }
  | { type: 'read'; timeoutMs?: number };

export type UiStep = Extract<Step, { type: 'click' | 'type' | 'press' | 'read' }>;
export const UI_STEP_TYPES: ReadonlyArray<Step['type']> = ['click', 'type', 'press', 'read'];

export const isUiStep = (s: Step): s is UiStep => UI_STEP_TYPES.includes(s.type);

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
  if (k === 'ticketSettled') {
    if (!isObj(val) || typeof val['key'] !== 'string') throw new Error(`${at}: ticketSettled needs a string key`);
    return { ticketSettled: { key: val['key'] } };
  }
  if (k === 'notification' || k === 'log' || k === 'webviewMessage') {
    if (typeof val !== 'string' || val === '') throw new Error(`${at}: ${k} needs a non-empty string`);
    return { [k]: val } as WaitCondition;
  }
  if (k === 'launch') {
    if (!isObj(val)) throw new Error(`${at}: launch needs an object`);
    const provider = val['provider'];
    if (provider !== undefined && (typeof provider !== 'string' || provider === '')) {
      throw new Error(`${at}: launch.provider must be a non-empty string`);
    }
    return { launch: provider === undefined ? {} : { provider } };
  }
  throw new Error(`${at}: unknown wait condition "${k}"`);
}

function parseTimeout(raw: Record<string, unknown>, at: string, maxMs: number): number | undefined {
  const t = raw['timeoutMs'];
  if (t === undefined) return undefined;
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) throw new Error(`${at}: timeoutMs must be a positive number`);
  return Math.min(t, maxMs);
}

/** A `data-act` value and a key chord are plain tokens; anything else could escape the selector built from it. */
const ACT_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const KEY_PATTERN = /^[A-Za-z0-9]+(\+[A-Za-z0-9]+)*$/;

function refuseUnknownKeys(raw: Record<string, unknown>, allowed: readonly string[], at: string): void {
  const extra = Object.keys(raw).filter((k) => !allowed.includes(k));
  if (extra.length > 0) throw new Error(`${at}: unknown field "${extra[0]}"`);
}

function nonEmptyString(v: unknown, what: string, at: string): string {
  if (typeof v !== 'string' || v === '') throw new Error(`${at}: ${what} needs a non-empty string`);
  return v;
}

function parseSurface(raw: Record<string, unknown>, at: string): UiSurface {
  const surface = raw['surface'];
  if (surface !== 'webview' && surface !== 'workbench') throw new Error(`${at}: selector target needs surface "webview" or "workbench"`);
  return surface;
}

function parseClickTarget(v: unknown, at: string): UiClickTarget {
  if (!isObj(v)) throw new Error(`${at}: "target" must be an object`);
  if ('act' in v) {
    refuseUnknownKeys(v, ['act'], `${at} target`);
    const act = nonEmptyString(v['act'], 'target.act', at);
    if (!ACT_PATTERN.test(act)) throw new Error(`${at}: target.act must be a plain data-act token`);
    return { act };
  }
  if ('quickPick' in v) {
    refuseUnknownKeys(v, ['quickPick'], `${at} target`);
    return { quickPick: nonEmptyString(v['quickPick'], 'target.quickPick', at) };
  }
  if ('selector' in v) {
    refuseUnknownKeys(v, ['selector', 'surface'], `${at} target`);
    return { selector: nonEmptyString(v['selector'], 'target.selector', at), surface: parseSurface(v, at) };
  }
  throw new Error(`${at}: click target must be one of act, quickPick, selector`);
}

function parseTypeTarget(v: unknown, at: string): UiTypeTarget {
  if (!isObj(v)) throw new Error(`${at}: "target" must be an object`);
  if ('quickInput' in v) {
    refuseUnknownKeys(v, ['quickInput'], `${at} target`);
    if (v['quickInput'] !== true) throw new Error(`${at}: target.quickInput must be true`);
    return { quickInput: true };
  }
  if ('selector' in v) {
    refuseUnknownKeys(v, ['selector', 'surface'], `${at} target`);
    return { selector: nonEmptyString(v['selector'], 'target.selector', at), surface: parseSurface(v, at) };
  }
  throw new Error(`${at}: type target must be one of quickInput, selector`);
}

function parseUiStep(type: UiStep['type'], raw: Record<string, unknown>, at: string, withTimeout: { timeoutMs?: number }): UiStep {
  switch (type) {
    case 'click':
      refuseUnknownKeys(raw, ['type', 'target', 'timeoutMs'], at);
      return { type, target: parseClickTarget(raw['target'], at), ...withTimeout };
    case 'type': {
      refuseUnknownKeys(raw, ['type', 'text', 'target', 'submit', 'timeoutMs'], at);
      const submit = raw['submit'];
      if (submit !== undefined && typeof submit !== 'boolean') throw new Error(`${at}: submit must be a boolean`);
      return { type, text: nonEmptyString(raw['text'], 'text', at), target: parseTypeTarget(raw['target'], at), ...(submit === undefined ? {} : { submit }), ...withTimeout };
    }
    case 'press': {
      refuseUnknownKeys(raw, ['type', 'key', 'timeoutMs'], at);
      const key = nonEmptyString(raw['key'], 'key', at);
      if (!KEY_PATTERN.test(key)) throw new Error(`${at}: key must be a key name or a chord like Control+Shift+P`);
      return { type, key, ...withTimeout };
    }
    case 'read':
      refuseUnknownKeys(raw, ['type', 'timeoutMs'], at);
      return { type, ...withTimeout };
  }
}

/** True when the script needs the Playwright driver (and so the CDP port). */
export const hasUiStep = (steps: readonly Step[]): boolean => steps.some(isUiStep);

/** Steps are data, never code: every field is validated and unknown step types are refused. */
export function parseSteps(json: unknown, maxStepMs: number = MAX_STEP_TIMEOUT_MS): Step[] {
  const list = isObj(json) ? json['steps'] : json;
  if (!Array.isArray(list) || list.length === 0) throw new Error('steps file must hold a non-empty steps array');
  return list.map((raw, i): Step => {
    const at = `step ${i}`;
    if (!isObj(raw)) throw new Error(`${at}: must be an object`);
    const timeoutMs = parseTimeout(raw, at, maxStepMs);
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
      case 'click':
      case 'type':
      case 'press':
      case 'read':
        return parseUiStep(raw['type'], raw, at, withTimeout);
      default:
        throw new Error(`${at}: unknown step type "${String(raw['type'])}"`);
    }
  });
}

/**
 * The review-stall suggestion (@arch:REVIEW-STALL): what karst writes when a
 * ticket parks as review-stalled, and the boundary check on the agent's JSON.
 * Pure: no store, no agent.
 */

export const MAX_STALL_OPTIONS = 3;
export const ACCEPT_OPTION_LABEL = 'Accept the report as it is';

/** `agent`: written by the model. `accept-docs`: added by the host, never by the model. */
export type StallOptionKind = 'agent' | 'accept-docs';

export interface StallOption {
  kind: StallOptionKind;
  label: string;
  /** Text for the fix agent. */
  note: string;
  /** Full replacement text; absent = unchanged. */
  description?: string;
  acceptanceCheck?: string;
  recommended: boolean;
}

export interface StallSuggestion {
  cause: string;
  options: StallOption[];
}

export type StallParse = { ok: true; value: StallSuggestion } | { ok: false; reason: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** The first top-level JSON object in the raw answer (a fence or chat text may surround it). */
function extractObject(raw: string): string | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  return start >= 0 && end > start ? raw.slice(start, end + 1) : null;
}

function parseOption(raw: unknown, index: number): { ok: true; value: StallOption } | { ok: false; reason: string } {
  if (!isObject(raw)) return { ok: false, reason: `option ${index + 1} is not an object` };
  const label = text(raw.label);
  const note = text(raw.note);
  if (label === '') return { ok: false, reason: `option ${index + 1} has no label` };
  if (note === '') return { ok: false, reason: `option ${index + 1} has no note` };
  for (const key of ['description', 'acceptanceCheck'] as const) {
    if (raw[key] !== undefined && raw[key] !== null && typeof raw[key] !== 'string') {
      return { ok: false, reason: `option ${index + 1} ${key} is not text` };
    }
  }
  if (raw.recommended !== undefined && typeof raw.recommended !== 'boolean') {
    return { ok: false, reason: `option ${index + 1} recommended is not a boolean` };
  }
  const description = text(raw.description);
  const acceptanceCheck = text(raw.acceptanceCheck);
  return {
    ok: true,
    value: {
      kind: 'agent',
      label,
      note,
      ...(description === '' ? {} : { description }),
      ...(acceptanceCheck === '' ? {} : { acceptanceCheck }),
      recommended: raw.recommended === true,
    },
  };
}

/** Validate the agent's answer at the boundary. Any defect = failed. */
export function parseStallSuggestion(raw: string): StallParse {
  const body = extractObject(raw);
  if (body === null) return { ok: false, reason: 'the answer has no JSON object' };
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'the answer is not valid JSON' };
  }
  if (!isObject(data)) return { ok: false, reason: 'the answer is not an object' };
  const cause = text(data.cause);
  if (cause === '') return { ok: false, reason: 'the answer has no cause' };
  if (!Array.isArray(data.options) || data.options.length < 1 || data.options.length > MAX_STALL_OPTIONS) {
    return { ok: false, reason: `the answer needs 1 to ${MAX_STALL_OPTIONS} options` };
  }
  const options: StallOption[] = [];
  for (const [i, o] of data.options.entries()) {
    const parsed = parseOption(o, i);
    if (!parsed.ok) return parsed;
    options.push(parsed.value);
  }
  const recommended = options.filter((o) => o.recommended).length;
  if (recommended !== 1) return { ok: false, reason: `exactly one option must be recommended (found ${recommended})` };
  return { ok: true, value: { cause, options } };
}

/**
 * The host-written Accept option for a docs-only ticket. Any `accept-docs`
 * option already in `suggestion` is dropped first: the agent cannot pass code
 * with open findings.
 */
export function withAcceptOption(suggestion: StallSuggestion, openBlocking: number): StallSuggestion {
  const own = suggestion.options.filter((o) => o.kind !== 'accept-docs');
  const accept: StallOption = {
    kind: 'accept-docs',
    label: ACCEPT_OPTION_LABEL,
    note:
      `Review passes with ${openBlocking} blocking finding${openBlocking === 1 ? '' : 's'} open. ` +
      'The findings stay in history and stay unfixed. No fix round opens, and the ticket continues to ship.',
    recommended: false,
  };
  return { ...suggestion, options: [...own, accept] };
}

/** The suggestion without its host-only options: what the store keeps. */
export function withoutHostOptions(suggestion: StallSuggestion): StallSuggestion {
  return { ...suggestion, options: suggestion.options.filter((o) => o.kind === 'agent') };
}

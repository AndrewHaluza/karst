/**
 * The pure half of the UAT baseline pre-check (@arch:BASELINE-PRECHECK): the
 * prompt builder, the answer schema and the boundary parser. No store, no
 * filesystem, no agent call — the lane in `baselinePrecheck.ts` owns those.
 */

import type { JsonSchemaDocument } from '../../agent/adapter.js';

/** Bound on each intent field re-entering the prompt (untrusted ticket prose). */
const MAX_INTENT_CHARS = 6_000;

/** One entry actually sent to the model, with the two image paths it must read. */
export interface BaselinePrecheckTarget {
  repo: string;
  path: string;
  /** The key the model answers with — `repo:path`, unique per entry. */
  label: string;
  status: 'added' | 'modified';
  newSha256: string;
  /** The temporary old image, or null for an `added` entry. */
  oldImagePath: string | null;
  /** The working-tree image. */
  newImagePath: string;
}

/** The ticket's stated UI intent, as the prompt quotes it. */
export interface BaselinePrecheckTicket {
  title: string;
  description: string;
  brief: string;
}

export interface BaselinePrecheckPromptInput {
  ticket: BaselinePrecheckTicket;
  uiPaths: readonly string[];
  targets: readonly BaselinePrecheckTarget[];
}

/** The answer contract a structured core is asked to enforce. */
export const BASELINE_PRECHECK_OUTPUT_SCHEMA: JsonSchemaDocument = {
  type: 'object',
  additionalProperties: false,
  required: ['entries'],
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'verdict', 'reason'],
        properties: {
          path: { type: 'string', minLength: 1 },
          verdict: { type: 'string', enum: ['approve', 'human'] },
          reason: { type: 'string' },
        },
      },
    },
  },
};

/** The key an entry line and the model's answer share. `repo:path` never collides across repos. */
export function precheckLabel(repo: string, path: string): string {
  return `${repo}:${path}`;
}

function boundedIntent(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_INTENT_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_INTENT_CHARS)}\n[truncated at ${MAX_INTENT_CHARS} characters]`;
}

/** The one prompt the pre-check sends: intent, changed UI paths, and every image pair. */
export function buildBaselinePrecheckPrompt(input: BaselinePrecheckPromptInput): string {
  const description = boundedIntent(input.ticket.description);
  const brief = boundedIntent(input.ticket.brief);
  const uiPaths = input.uiPaths.length === 0 ? ['(none reported)'] : input.uiPaths.map((path) => `- ${path}`);
  return [
    `You are the baseline pre-check for Karst's UAT stage. A ticket changed screenshot baselines; a human normally reviews each one. Decide which entries are CLEARLY the intended UI change and free of visible defects. Everything you do not approve waits for the human, exactly as today.`,
    ``,
    `Ticket: ${input.ticket.title}`,
    ...(description === '' ? [] : [`Description:`, description]),
    ...(brief === '' ? [] : [`Design brief:`, brief]),
    ``,
    `Changed src/ui paths on the ticket's branch:`,
    ...uiPaths,
    ``,
    `Baseline entries — open EACH image file below and look at it (the old image is the base-commit version, the new image is the ticket's working tree):`,
    ...input.targets.map((target) =>
      target.oldImagePath === null
        ? `- ${target.label}: new ${target.newImagePath} (added file — no old image)`
        : `- ${target.label}: old ${target.oldImagePath} | new ${target.newImagePath}`,
    ),
    ``,
    `How to decide:`,
    `- Answer "approve" ONLY when BOTH hold: (a) the visible change is explained by the ticket's stated UI change, and (b) the new image shows no visible defect: clipped or overlapping text, missing content, a broken or shifted layout that is not part of the intent, wrong theme colours, or an empty or error page.`,
    `- Answer "human" in EVERY other case: a change you cannot tie to the intent, an unchanged-looking pair, a visible defect, an image you cannot read, or any doubt.`,
    `- For a modified entry compare old and new; for an added entry judge the new image alone.`,
    `- Approve only what you can see. Never guess. If you cannot see the pixels of an image, answer "human" for that entry.`,
    ``,
    `Output ONLY a JSON object with one entry for every path above, using the path exactly as written:`,
    `{"entries":[{"path":"<path>","verdict":"approve"|"human","reason":"<one line>"}]}`,
  ].join('\n');
}

type JsonRead = { ok: true; value: unknown } | { ok: false };

/**
 * Balanced `{…}` objects in `raw`, in order, ignoring braces inside strings.
 * A core without structured output answers in prose (or a fence), so the answer
 * object has to be found rather than assumed to be the whole message.
 */
function jsonObjectCandidates(raw: string): string[] {
  const out: string[] = [];
  for (let start = raw.indexOf('{'); start !== -1; start = raw.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < raw.length; i += 1) {
      const char = raw[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          out.push(raw.slice(start, i + 1));
          break;
        }
      }
    }
  }
  return out;
}

function parseShaped(candidate: string): JsonRead {
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    return { ok: false }; // Not JSON: the caller tries the next candidate.
  }
  return isRecord(value) && Array.isArray(value.entries) ? { ok: true, value } : { ok: false };
}

/**
 * The answer object (`entries`) in `raw`. A whole-text JSON answer is read as
 * is; otherwise the LAST shaped object wins, so an earlier draft (or a fenced
 * draft) that the model corrected later can never approve an entry.
 */
function readJsonDocument(raw: string): JsonRead {
  const whole = parseShaped(raw.trim());
  if (whole.ok) return whole;
  let last: JsonRead = { ok: false };
  for (const candidate of jsonObjectCandidates(raw)) {
    const read = parseShaped(candidate);
    if (read.ok) last = read;
  }
  return last;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the model's answer at the boundary. Returns the approved labels with
 * their trimmed reasons, or `null` when nothing JSON-shaped could be read. An
 * unknown path is ignored, a duplicate path approves neither copy, a missing
 * entry approves nothing, and a `human`/empty-reason entry never approves.
 */
export function parseBaselinePrecheckAnswer(
  raw: string,
  allowedLabels: readonly string[],
  finalMessage?: string,
): Map<string, string> | null {
  // The core's final message is the model's last word, so it wins over the
  // raw stream, which can still hold an earlier draft answer.
  const fromFinal = finalMessage === undefined ? { ok: false as const } : readJsonDocument(finalMessage);
  const read = fromFinal.ok ? fromFinal : readJsonDocument(raw);
  if (!read.ok) return null;
  if (!isRecord(read.value) || !Array.isArray(read.value.entries)) return null;
  const counts = new Map<string, number>();
  const reasons = new Map<string, string>();
  for (const item of read.value.entries) {
    if (!isRecord(item) || typeof item.path !== 'string') continue;
    const key = item.path;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (item.verdict !== 'approve' || typeof item.reason !== 'string') continue;
    const reason = item.reason.trim();
    if (reason !== '') reasons.set(key, reason);
  }
  const allowed = new Set(allowedLabels);
  const approved = new Map<string, string>();
  for (const [key, reason] of reasons) {
    if (allowed.has(key) && counts.get(key) === 1) approved.set(key, reason);
  }
  return approved;
}

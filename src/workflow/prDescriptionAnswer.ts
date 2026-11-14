/**
 * The PR description agent's JSON answer: schema, parse, validate, render.
 *
 * The agent returns data, never markdown; code owns the layout, so a model
 * error cannot show in a public PR body. Host-agnostic: no `vscode` import.
 * `prDescription.ts` keeps the prompt material and the sanitizer, which is the
 * fallback for text that is not JSON.
 */

import type { JsonSchemaDocument } from '../agent/adapter.js';
import type { StructuredOutputForm } from '../agent/surfaces.js';

export interface PrDescriptionAnswer {
  /** Markdown allowed. Required, non-empty after trim. */
  summary: string;
  /** Required but nullable. The behavior-diagram draft renders it; this draft ignores it. */
  behavior: string | null;
  whereToLook?: string[];
  risk?: string;
  needsHuman?: string[];
}

export type PrDescriptionParse =
  | { kind: 'ok'; answer: PrDescriptionAnswer }
  /** The text holds no JSON: the caller falls back to the sanitizer. */
  | { kind: 'not-json' }
  /** JSON that breaks the schema: the caller falls back to the template body. */
  | { kind: 'invalid'; reason: string };

/** The line code renders when the gate set changed (the model is not asked to). */
export const GATE_SET_CHANGED_LINE =
  'The gate set changed since the previous attempt of a gate stage — a gate may have been removed rather than fixed.';

/** What a structured core enforces (claude `--json-schema`, codex `--output-schema`). */
export const PR_DESCRIPTION_OUTPUT_SCHEMA: JsonSchemaDocument = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    behavior: { type: ['string', 'null'] },
    whereToLook: { type: 'array', items: { type: 'string' } },
    risk: { type: 'string' },
    needsHuman: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'behavior'],
};

const FIRST_RULE: Readonly<Record<StructuredOutputForm | 'none', string>> = {
  tool: '- Finish by calling the StructuredOutput tool with the answer object. Write no description as text.',
  'final-document':
    '- Your final message is ONLY one JSON object: no preamble, no markdown fence, no commentary.',
  none: '- Output ONLY one JSON object (a bare object or one ```json fence): no preamble, no commentary.',
};

/** The prose contract for a core's structured-output form; pinned to the schema by a test. */
export function prDescriptionOutputRules(form: StructuredOutputForm | undefined): readonly string[] {
  return [
    FIRST_RULE[form ?? 'none'],
    '- "summary": string, required, not empty. What the change does and why, in GitHub-flavored markdown. Add no heading.',
    '- "behavior": string or null, required. Use null.',
    '- "whereToLook": optional array of strings. Each item names a file or area a reviewer reads first.',
    '- "risk": optional string. What can break, in one or two sentences.',
    '- "needsHuman": optional array of strings. Each item is a decision or check only a person can make.',
    '- Base the description ONLY on the material above and use only facts it shows. Do not run commands, open files, or inspect the repository — everything you need is included.',
  ];
}

const FENCE = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/iu;

function jsonCandidate(text: string): string {
  const t = text.trim();
  return FENCE.exec(t)?.[1]?.trim() ?? t;
}

function stringList(value: unknown, key: string): string[] | undefined | string {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    return `"${key}" must be an array of strings`;
  }
  return value as string[];
}

/** Parse and validate one agent answer. Never throws. */
export function parsePrDescriptionAnswer(text: string): PrDescriptionParse {
  let value: unknown;
  try {
    value = JSON.parse(jsonCandidate(text));
  } catch {
    return { kind: 'not-json' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { kind: 'invalid', reason: 'the JSON value is not an object' };
  }
  const o = value as Record<string, unknown>;
  if (typeof o.summary !== 'string' || o.summary.trim() === '') {
    return { kind: 'invalid', reason: '"summary" must be a non-empty string' };
  }
  if (o.behavior !== null && typeof o.behavior !== 'string') {
    return { kind: 'invalid', reason: '"behavior" must be a string or null' };
  }
  if (o.risk !== undefined && typeof o.risk !== 'string') {
    return { kind: 'invalid', reason: '"risk" must be a string' };
  }
  const where = stringList(o.whereToLook, 'whereToLook');
  if (typeof where === 'string') return { kind: 'invalid', reason: where };
  const needs = stringList(o.needsHuman, 'needsHuman');
  if (typeof needs === 'string') return { kind: 'invalid', reason: needs };
  const answer: PrDescriptionAnswer = {
    summary: o.summary,
    behavior: o.behavior,
    ...(where ? { whereToLook: where } : {}),
    ...(typeof o.risk === 'string' ? { risk: o.risk } : {}),
    ...(needs ? { needsHuman: needs } : {}),
  };
  return { kind: 'ok', answer };
}

function bullets(items: readonly string[] | undefined): string[] {
  return (items ?? []).map((i) => i.trim()).filter((i) => i !== '').map((i) => `- ${i}`);
}

/**
 * Render the narrative body: summary (no heading — the template's `## Summary`
 * wraps it), then Where to look, Risk, Needs a human, each only with text.
 */
export function renderNarrative(
  answer: PrDescriptionAnswer,
  ctx: { gateSetChanged?: boolean },
): string {
  const blocks = [answer.summary.trim()];
  const where = bullets(answer.whereToLook);
  if (where.length > 0) blocks.push(`## Where to look\n\n${where.join('\n')}`);
  const risk = answer.risk?.trim() ?? '';
  if (risk !== '') blocks.push(`## Risk\n\n${risk}`);
  const needs = bullets(answer.needsHuman);
  if (needs.length > 0) blocks.push(`## Needs a human\n\n${needs.join('\n')}`);
  if (ctx.gateSetChanged) blocks.push(GATE_SET_CHANGED_LINE);
  return blocks.join('\n\n');
}

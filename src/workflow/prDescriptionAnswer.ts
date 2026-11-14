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
import { renderBehaviorDiagram } from './prVisuals.js';

export interface PrDescriptionAnswer {
  /** Markdown allowed. Required, non-empty after trim. */
  summary: string;
  /**
   * Required but nullable: `{ before: Step[]; after: Step[] }` or null. Kept as
   * given; `renderBehaviorDiagram` judges it, so a broken one never fails the answer.
   */
  behavior: unknown;
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

const STEP_SCHEMA: JsonSchemaDocument = {
  type: 'object',
  properties: {
    label: { type: 'string' },
    kind: { type: ['string', 'null'], enum: ['ok', 'bad', null] },
  },
  required: ['label'],
};

/** What a structured core enforces (claude `--json-schema`, codex `--output-schema`). */
export const PR_DESCRIPTION_OUTPUT_SCHEMA: JsonSchemaDocument = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    behavior: {
      type: ['object', 'null'],
      properties: {
        before: { type: 'array', items: STEP_SCHEMA },
        after: { type: 'array', items: STEP_SCHEMA },
      },
      required: ['before', 'after'],
    },
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
    '- "behavior": object or null, required. The object is { "before": [steps], "after": [steps] }: how the behavior ran before the change and how it runs after. Use null for a refactor, docs-only, or tests-only change.',
    '- Each side of "behavior" has 1 to 6 steps, in order. A step is { "label": string, "kind": "ok" | "bad" }. "label" is short plain text (60 characters at most). "kind" is optional: "bad" marks a step that is wrong or risky, "ok" marks a step that is right. Use only steps the material shows. Write no diagram syntax; code draws the diagram.',
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
 * wraps it), then Where to look, Risk, Needs a human, each only with text,
 * then the Behavior diagram when the answer has a valid one.
 */
export function renderNarrative(
  answer: PrDescriptionAnswer,
  ctx: { gateSetChanged?: boolean; debug?: (message: string) => void },
): string {
  const blocks = [answer.summary.trim()];
  const where = bullets(answer.whereToLook);
  if (where.length > 0) blocks.push(`## Where to look\n\n${where.join('\n')}`);
  const risk = answer.risk?.trim() ?? '';
  if (risk !== '') blocks.push(`## Risk\n\n${risk}`);
  const needs = bullets(answer.needsHuman);
  if (needs.length > 0) blocks.push(`## Needs a human\n\n${needs.join('\n')}`);
  const diagram = renderBehaviorDiagram(answer.behavior, ctx.debug);
  if (diagram !== null) blocks.push(diagram);
  if (ctx.gateSetChanged) blocks.push(GATE_SET_CHANGED_LINE);
  return blocks.join('\n\n');
}

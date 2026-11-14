/**
 * The `## Behavior` section of the AI-written PR body: a mermaid before/after
 * flowchart that CODE builds from the data in the agent's JSON answer. The
 * agent never writes mermaid. Host-agnostic: no `vscode` import.
 *
 * Only `flowchart LR`, `subgraph`, `-->`, `classDef` and `class` are used, so
 * a GitHub mermaid older than the repo's own still draws the diagram.
 */

export type BehaviorStepKind = 'ok' | 'bad';

export interface BehaviorStep {
  label: string;
  kind?: BehaviorStepKind;
}

export interface Behavior {
  before: BehaviorStep[];
  after: BehaviorStep[];
}

/** The visible note under the diagram. */
export const BEHAVIOR_NOTE = '<sub>Drawn by the agent from the diff.</sub>';

/** The step count a side may have. */
export const BEHAVIOR_MIN_STEPS = 1;
export const BEHAVIOR_MAX_STEPS = 6;
/** The label length cap, in characters, applied before encoding. */
export const BEHAVIOR_LABEL_MAX = 60;

const KINDS: readonly BehaviorStepKind[] = ['ok', 'bad'];
const CLASS_DEFS: Readonly<Record<BehaviorStepKind, string>> = {
  bad: 'classDef bad stroke:#cf222e',
  ok: 'classDef ok stroke:#1a7f37',
};
/** Characters a label keeps as they are; every other one becomes `#<decimal>;`. */
const SAFE_LABEL_CHAR = /^[A-Za-z0-9 .,:_/+=-]$/u;
const CONTROL_RUN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu;

type StepsResult = { steps: BehaviorStep[] } | { reason: string };

function readSteps(value: unknown, side: string): StepsResult {
  if (!Array.isArray(value)) return { reason: `"${side}" is not an array` };
  if (value.length < BEHAVIOR_MIN_STEPS || value.length > BEHAVIOR_MAX_STEPS) {
    return { reason: `"${side}" has ${value.length} steps, expected ${BEHAVIOR_MIN_STEPS} to ${BEHAVIOR_MAX_STEPS}` };
  }
  const steps: BehaviorStep[] = [];
  for (const [i, s] of value.entries()) {
    if (typeof s !== 'object' || s === null || Array.isArray(s)) {
      return { reason: `"${side}" step ${i + 1} is not an object` };
    }
    const { label, kind } = s as Record<string, unknown>;
    if (typeof label !== 'string' || cleanLabel(label) === '') {
      return { reason: `"${side}" step ${i + 1} has no label text` };
    }
    if (kind !== undefined && kind !== null && !KINDS.includes(kind as BehaviorStepKind)) {
      return { reason: `"${side}" step ${i + 1} has an unknown kind` };
    }
    steps.push({ label, ...(typeof kind === 'string' ? { kind: kind as BehaviorStepKind } : {}) });
  }
  return { steps };
}

/** Trim, turn line breaks and control characters into spaces, collapse spaces. */
function cleanLabel(label: string): string {
  return label.replace(CONTROL_RUN, ' ').replace(/ {2,}/gu, ' ').trim();
}

function encodeLabel(label: string): string {
  const chars = [...cleanLabel(label)];
  const capped = chars.length > BEHAVIOR_LABEL_MAX ? [...chars.slice(0, BEHAVIOR_LABEL_MAX), '…'] : chars;
  return capped
    .map((c) => (SAFE_LABEL_CHAR.test(c) ? c : `#${c.codePointAt(0)};`))
    .join('');
}

interface Node {
  id: string;
  kind: BehaviorStepKind | undefined;
}

function subgraph(
  id: 'before' | 'after',
  title: string,
  prefix: 'b' | 'a',
  steps: readonly BehaviorStep[],
): { lines: string[]; nodes: Node[] } {
  const nodes: Node[] = steps.map((s, i) => ({ id: `${prefix}${i + 1}`, kind: s.kind }));
  const chain = steps.map((s, i) => `${nodes[i]!.id}["${encodeLabel(s.label)}"]`).join(' --> ');
  return { lines: [`  subgraph ${id}["${title}"]`, `    ${chain}`, '  end'], nodes };
}

/**
 * Build the `## Behavior` section. Returns null — and the narrative stays —
 * when `behavior` is null or missing (no debug line) or breaks a rule (one
 * `[ship]` debug line names the reason).
 */
export function renderBehaviorDiagram(
  behavior: unknown,
  debug?: (message: string) => void,
): string | null {
  if (behavior === null || behavior === undefined) return null;
  if (typeof behavior !== 'object' || Array.isArray(behavior)) {
    debug?.('[ship] behavior diagram skipped: "behavior" is not an object');
    return null;
  }
  const o = behavior as Record<string, unknown>;
  const before = readSteps(o.before, 'before');
  if ('reason' in before) {
    debug?.(`[ship] behavior diagram skipped: ${before.reason}`);
    return null;
  }
  const after = readSteps(o.after, 'after');
  if ('reason' in after) {
    debug?.(`[ship] behavior diagram skipped: ${after.reason}`);
    return null;
  }
  const b = subgraph('before', 'Before', 'b', before.steps);
  const a = subgraph('after', 'After', 'a', after.steps);
  const nodes = [...b.nodes, ...a.nodes];
  const classLines: string[] = [];
  for (const kind of ['bad', 'ok'] as const) {
    const ids = nodes.filter((n) => n.kind === kind).map((n) => n.id);
    if (ids.length > 0) classLines.push(`  ${CLASS_DEFS[kind]}`, `  class ${ids.join(',')} ${kind}`);
  }
  const code = ['flowchart LR', ...b.lines, ...a.lines, ...classLines].join('\n');
  return `## Behavior\n\n\`\`\`mermaid\n${code}\n\`\`\`\n\n${BEHAVIOR_NOTE}`;
}

/**
 * Terminal names for graph sessions (planner and node). Pure and vscode-free.
 *
 * Every graph terminal shares the ticket's terminal name, so a person cannot
 * tell the tabs apart. This module adds the role and, for a node, the plan
 * node id. The node id comes from planner output, so it is sanitized before
 * it reaches a tab title.
 */

/** Maximum length (in characters) of the node label in a tab name. */
export const GRAPH_NODE_LABEL_MAX = 40;

const ELLIPSIS = '…';

// C0 controls, DEL, C1 controls, and all Unicode format characters
// (bidi overrides and isolates, zero-width characters, the BOM).
const UNSAFE_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Cf}]/gu;

/** Remove unsafe characters, collapse whitespace, trim and cap the length.
 *  Returns undefined when nothing is left. */
export function sanitizeGraphNodeLabel(raw: string): string | undefined {
  const clean = raw.replace(UNSAFE_CHARS, '').replace(/\s+/gu, ' ').trim();
  if (clean === '') return undefined;
  const chars = [...clean];
  if (chars.length <= GRAPH_NODE_LABEL_MAX) return clean;
  return `${chars.slice(0, GRAPH_NODE_LABEL_MAX - 1).join('').trimEnd()}${ELLIPSIS}`;
}

export interface GraphSessionNameInput {
  ticketName: string;
  kind: 'planner' | 'node';
  runId: number;
  /** The plan node id (`approach_node_runs.node_id`); node sessions only. */
  nodeId?: string | undefined;
  /** `launch_attempt` of the run; a value above 1 marks a relaunch. */
  launchAttempt?: number | undefined;
}

/** `<ticket> · planner` or `<ticket> · <node id>`, with ` #<attempt>` on a relaunch. */
export function graphSessionTerminalName(input: GraphSessionNameInput): string {
  const role =
    input.kind === 'planner'
      ? 'planner'
      : (sanitizeGraphNodeLabel(input.nodeId ?? '') ?? `node ${input.runId}`);
  const relaunch =
    input.launchAttempt !== undefined && input.launchAttempt > 1 ? ` #${input.launchAttempt}` : '';
  return `${input.ticketName} · ${role}${relaunch}`;
}

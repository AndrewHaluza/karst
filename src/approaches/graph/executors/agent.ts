/**
 * Agent node executor (Slice 3 Task 4).
 *
 * Launches a fresh interactive session: the node receives current ticket
 * context, the node base prompt (`karst-graph-node`) prepended ahead of its
 * instructions artifact, the instructions artifact body, and its declared
 * immutable input artifact instances — and NO prior session id and NO
 * prior-node transcript; a fresh visit never gets `--resume` for another
 * node, even on the same provider (the executor never sets `resume`).
 *
 * Its resolved provider/model/effort and prompt hash are frozen for that
 * launch attempt. Core-level automatic model fallback must be disabled or
 * overridden per launch and the effective model verified from structured
 * lifecycle data; a core that can neither prevent fallback nor prove which
 * model ran lacks the `exact-model` capability, and the node RED-BLOCKS
 * before spending tokens — no launch, no session, no spend.
 *
 * The agent session itself is supervised by the transport; the completion
 * path (terminate → verify → diff snapshot → integrate) belongs to the
 * completion protocol (Slice-3 T5/T8). This executor's job is the launch
 * composition and the spend guards.
 *
 * Host-agnostic. The launch request types are re-exported by the transport
 * module so this file never imports `agent/adapter.js` — keeping the sole
 * bridge pin intact.
 */

import type { AgentNode } from '../parse.js';
import type {
  AgentTransport,
  SupervisedAgentSession,
  SupervisedLaunchRequest,
  AgentAdapter,
} from '../transport/supervisedCliTransport.js';

export type AgentNodeLaunchResult =
  | { kind: 'launched'; session: SupervisedAgentSession; identity: FrozenIdentity }
  | { kind: 'red-blocked'; reason: string };

/** Provider/model/effort/prompt hash frozen for one launch attempt. */
export interface FrozenIdentity {
  provider: string;
  model: string | undefined;
  effort: string | undefined;
  promptHash: string;
}

export interface RunAgentNodeDeps {
  transport: AgentTransport;
  /** Resolve the node's profile to provider/model/effort. */
  resolveProfile: (profile: string) => { provider: string; model?: string; effort?: string };
  /** Body of the instructions artifact (bounded), or undefined when missing. */
  readInstructions: (snapshotPath: string) => string | undefined;
  /** Bodies of the declared input artifacts, in declaration order (bounded). */
  readInputs: (snapshotPaths: readonly string[]) => string[];
  /** Current ticket context (bounded by the ticket-context shaping). */
  ticketContext: string;
  /** The `karst-graph-node` base prompt. */
  nodePrompt: string;
  promptHash: (text: string) => string;
  /** Graph-environment additions (KARST_GRAPH_*) for the launch. */
  graphEnv: (launch: {
    nodeRunId: number;
    ticketId: number;
    graphRunId: number;
    revisionId: number;
    generation: string;
  }) => Record<string, string>;
  onDebug?: (message: string) => void;
}

export interface RunAgentNodeInput {
  nodeRunId: number;
  ticketId: number;
  graphRunId: number;
  revisionId: number;
  /** The adapter the transport bridges from (wiring-resolved per provider). */
  adapter: AgentAdapter;
  /** Repository whose worktree the session runs in. */
  repo: string;
  /** Workspace directory. */
  cwd: string;
  /** The pinned node definition from the active revision. */
  node: AgentNode;
  /** Frozen launch generation for this launch attempt. */
  generation: string;
  /** Path of the instructions artifact snapshot. */
  instructionsSnapshot: string;
  /** Paths of the declared input artifact snapshots. */
  inputSnapshots: readonly string[];
}

/**
 * Compose the fresh-session seed: node base prompt, ticket context, the
 * instructions artifact, then the declared input artifacts. It contains NO
 * prior-node transcript by construction (the executor is given none), and
 * the launch carries no `resume`.
 */
export function composeNodePrompt(
  nodePrompt: string,
  ticketContext: string,
  instructions: string | undefined,
  inputs: readonly string[],
): string {
  const parts = [nodePrompt, ticketContext];
  if (instructions !== undefined) parts.push(instructions);
  parts.push(...inputs);
  return parts.filter((p) => p.length > 0).join('\n\n');
}

export async function runAgentNode(
  deps: RunAgentNodeDeps,
  input: RunAgentNodeInput,
): Promise<AgentNodeLaunchResult> {
  // Capability gate BEFORE any spend: a core that can neither prevent model
  // fallback nor prove which model ran red-blocks without launching.
  const exactModel = input.adapter.surfaces?.exactModel;
  if (!exactModel?.supported) {
    const reason =
      exactModel && !exactModel.supported
        ? exactModel.reason
        : 'the adapter does not declare exact-model support';
    deps.onDebug?.(
      `[graph] agent node ${input.nodeRunId}: core lacks exact-model capability — red-blocking before spend`,
    );
    return {
      kind: 'red-blocked',
      reason: `exact-model-capability: ${reason}`,
    };
  }
  const resolved = deps.resolveProfile(input.node.profile);
  const instructions = deps.readInstructions(input.instructionsSnapshot);
  const inputs = deps.readInputs(input.inputSnapshots);
  const prompt = composeNodePrompt(deps.nodePrompt, deps.ticketContext, instructions, inputs);
  const identity: FrozenIdentity = {
    provider: resolved.provider,
    model: resolved.model,
    effort: resolved.effort,
    promptHash: deps.promptHash(prompt),
  };
  const launch: SupervisedLaunchRequest = {
    nodeRunId: input.nodeRunId,
    ticketId: input.ticketId,
    graphRunId: input.graphRunId,
    repo: input.repo,
    cwd: input.cwd,
    generation: input.generation,
    sessionName: `Karst node ${input.nodeRunId}`,
    graphEnv: deps.graphEnv({
      nodeRunId: input.nodeRunId,
      ticketId: input.ticketId,
      graphRunId: input.graphRunId,
      revisionId: input.revisionId,
      generation: input.generation,
    }),
    adapter: input.adapter,
    interactive: {
      cwd: input.cwd,
      model: resolved.model,
      effort: resolved.effort,
      initialPrompt: prompt,
      sessionName: `Karst node ${input.nodeRunId}`,
    },
  };
  const session = await deps.transport.start(launch);
  deps.onDebug?.(
    `[graph] agent node ${input.nodeRunId} launched (${identity.provider}/${identity.model ?? 'default'}/${identity.effort ?? 'default'})`,
  );
  return { kind: 'launched', session, identity };
}

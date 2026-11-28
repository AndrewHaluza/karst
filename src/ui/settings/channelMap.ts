/**
 * The read-only channel map behind Settings › Agents › Channels
 * (`@arch:CHANNEL-MAP`).
 *
 * Karst gives an agent session many channels — the CLI + env refs, the karst MCP
 * tools, lifecycle hooks, the instruction layer, the guide pointer, mail
 * pointers, parent/sub-task mail, and the sandbox bridge files. This module is
 * the ONE place that says which session kind gets which channel on which core,
 * so the tab renders facts instead of a hand-kept per-core table.
 *
 * The core-dependent cells are READ from the same seam the launch uses:
 * `resolveAdapter(p).surfaces.mcpConfigInteractive` / `.hookChannel` for the
 * MCP and hook channels, `resolveAdapter(p).instructions` for the instruction
 * layer, `messageRouteFor` for mail, and `PLANNING_VERBS` for the planning
 * command surface. A new channel, or a change to one of those surfaces, must
 * update this module in the same commit.
 *
 * Pure and vscode-free: the host builds the view in `buildSettingsState` and
 * pushes it with the rest of the settings state; the webview derives nothing.
 */
import type { AgentProvider } from '../../manifest/types.js';
import { resolveAdapter } from '../../agent/registry.js';
import type { AgentAdapter, InstructionDelivery } from '../../agent/adapter.js';
import type { AdapterSurfaces, SurfaceSupport } from '../../agent/surfaces.js';
import { PLANNING_VERBS } from '../../cli/planningVerbs.js';
import { messageRouteFor } from '../../extension/ops/messageDeliveryOps.js';
import { CODEX_STOP_BLOCK_SUPPORTED } from '../../extension/ops/mailDeliveryWiring.js';

/** The seven channel columns of the map, in render order. */
export type ChannelColumn = 'commands' | 'mcp' | 'hooks' | 'instructions' | 'guide' | 'mail' | 'parentMail';

/** The session kinds the map explains, in render order. */
export type SessionKind = 'ticket' | 'sandbox' | 'planning' | 'setup' | 'graph' | 'headless';

/**
 * One channel cell: its verdict for the session kind, the short value to show,
 * and (when there is one) the reason the verdict is what it is. A `no` cell
 * that comes from an adapter surface carries that surface's own reason, never a
 * summary this module made up.
 */
export interface ChannelCell {
  readonly state: 'yes' | 'no' | 'partial';
  readonly value: string;
  readonly reason?: string;
}

export interface ChannelRow {
  readonly kind: SessionKind;
  readonly cells: Readonly<Record<ChannelColumn, ChannelCell>>;
}

export interface ChannelMapCore {
  readonly core: AgentProvider;
  readonly rows: readonly ChannelRow[];
}

export interface ChannelMapView {
  readonly cores: readonly ChannelMapCore[];
}

const yes = (value: string, reason?: string): ChannelCell =>
  reason === undefined ? { state: 'yes', value } : { state: 'yes', value, reason };

const partial = (value: string, reason?: string): ChannelCell =>
  reason === undefined ? { state: 'partial', value } : { state: 'partial', value, reason };

const no = (value: string, reason?: string): ChannelCell =>
  reason === undefined ? { state: 'no', value } : { state: 'no', value, reason };

/**
 * A cell for an adapter surface: `yes` when the core translates the field,
 * `no` with the surface's own reason when it does not.
 */
function surfaceCell(
  surface: SurfaceSupport | undefined,
  supportedValue: string,
  supportedReason?: string,
): ChannelCell {
  if (surface === undefined) return { state: 'no', value: 'No', reason: 'this core declares no such surface' };
  if (surface.supported) return yes(supportedValue, supportedReason);
  return no('No', surface.reason);
}

/** The ticket MCP channel (`@arch:AC-52`): a per-launch config on every core but agy. */
function ticketMcp(adapter: AgentAdapter): ChannelCell {
  return surfaceCell(adapter.surfaces?.mcpConfigInteractive, 'Yes');
}

/** The ticket hook channel (`@arch:AC-26`): the installed bridge, or agy's watched conversation DB. */
function ticketHooks(adapter: AgentAdapter): ChannelCell {
  return surfaceCell(adapter.surfaces?.hookChannel, 'Yes');
}

/**
 * The instruction layer (`@arch:AC-09`): `native-file` is the core's own system
 * prompt; `pointer` is a one-line pointer that is inlined into the kickoff when
 * the core cannot keep its native channel beside a solo agent.
 */
function instructionCell(instructions: InstructionDelivery | undefined): ChannelCell {
  if (instructions === undefined) return no('No', 'this core declares no instruction channel');
  switch (instructions.interactive) {
    case 'native-file':
      return yes('System prompt');
    case 'pointer':
      return partial('Pointer', instructions.soloFallback === true ? 'inlined for a solo agent' : undefined);
    case 'fallback':
      return partial('Inlined', 'the native channel cannot coexist with a solo agent');
    case 'n/a':
      return no('No', 'not wired for the instruction layer');
  }
}

/** The mail pointer route (`@arch:MAILBOX`), resolved from the live core at delivery time. */
function mailCell(core: AgentProvider): ChannelCell {
  switch (messageRouteFor(core, CODEX_STOP_BLOCK_SUPPORTED)) {
    case 'hook-block':
      return yes('Stop-hook reply');
    case 'plugin-idle':
      return yes('Plugin on idle');
    case 'typed':
      return partial('Typed', 'typed into the terminal');
  }
}

/** The ticket session (`@arch:AC-12`, `@arch:AC-24`, `@arch:MAILBOX`). */
function ticketRow(core: AgentProvider, adapter: AgentAdapter): ChannelRow {
  return {
    kind: 'ticket',
    cells: {
      // @arch:AC-12 — every ticket terminal exports the `"$KARST_*"` env refs.
      commands: yes('CLI + env'),
      // @arch:AC-52 — the per-launch MCP config (claude `--mcp-config`, codex `mcp_servers`, opencode config content).
      mcp: ticketMcp(adapter),
      // @arch:AC-26 / HOOK-CONTRACT — the installed hook bridge is the signal path.
      hooks: ticketHooks(adapter),
      // @arch:AC-09 — the instruction layer rides the core's own system/developer channel.
      instructions: instructionCell(adapter.instructions),
      // @arch:AC-24 — the guide pointer rides a fresh launch, never a resume.
      guide: yes('Fresh launch', 'not on resume'),
      // @arch:MAILBOX — the push route is resolved from the live core at delivery time.
      mail: mailCell(core),
      // @arch:MAILBOX — `message send` / `inbox` reach a parent or a sub-task in any session.
      parentMail: yes('Yes', 'message send / inbox'),
    },
  };
}

/** The sandbox backend (`@arch:AC-34`): bridge files replace CLI, MCP and hooks. */
function sandboxRow(): ChannelRow {
  return {
    kind: 'sandbox',
    cells: {
      // @arch:AC-34 — emit-marker / emit-ack are the sandbox's command channel.
      commands: partial('Bridge files', 'emit-marker / emit-ack'),
      // @arch:AC-34 — a sandbox has neither the host CLI nor MCP inside it.
      mcp: no('No', 'not inside a sandbox'),
      // @arch:AC-34 — lifecycle arrives as bridge events on events.ndjson.
      hooks: partial('Bridge events', 'events.ndjson poll'),
      // @arch:AC-34 — the brief is written into the run dir, not the system prompt.
      instructions: partial('Sandbox text'),
      // @arch:AC-34 — no guide pointer inside an isolated run.
      guide: no('No'),
      // @arch:AC-34 — mail pointers are typed into the sandbox terminal.
      mail: partial('Typed'),
      // @arch:AC-34 — parent/sub-task mail is not wired for a sandbox.
      parentMail: no('No'),
    },
  };
}

/** The planning session (`@arch:CLI-13`, `src/extension/ops/planningOps.ts`): reads only. */
function planningRow(): ChannelRow {
  return {
    kind: 'planning',
    cells: {
      // @arch:CLI-13 — the CLI guard allows exactly PLANNING_VERBS, then `notes --repos`.
      commands: partial('9 verbs', `${PLANNING_VERBS.join(', ')}; notes read`),
      // src/extension/ops/planningOps.ts — a planning launch passes no MCP config.
      mcp: no('No'),
      // src/extension/ops/planningOps.ts — and no hook channel.
      hooks: no('No'),
      // planning/preamble.ts — the planning preamble carries the instruction layer.
      instructions: yes('Preamble'),
      // planning/preamble.ts — the guide is read through the allowed `guide` verb.
      guide: yes('Yes'),
      // @arch:CLI-13 — no mail route into a planning session.
      mail: no('No'),
      // @arch:CLI-13 — and no parent/sub-task mail.
      parentMail: no('No'),
    },
  };
}

/** The setup session (`src/extension/ops/setupOps.ts`): MCP yes, no hook channel. */
function setupRow(adapter: AgentAdapter): ChannelRow {
  return {
    kind: 'setup',
    cells: {
      // src/extension/ops/setupOps.ts — a setup launch still gets the CLI + env refs.
      commands: yes('CLI + env'),
      // src/extension/ops/setupOps.ts — `launchHasMcp(..., hookChannel: true)` adds the setup-* tools.
      mcp: surfaceCell(adapter.surfaces?.mcpConfigInteractive, 'Yes', '+ setup-* tools'),
      // src/extension/ops/setupOps.ts — a setup launch passes no hook channel.
      hooks: no('No'),
      // setup sessions read their checklist from the instruction layer.
      instructions: yes('Yes'),
      // src/setup — the setup checklist is the guide surface.
      guide: yes('Yes'),
      // setup sessions take no mail.
      mail: no('No'),
      // and no parent/sub-task mail.
      parentMail: no('No'),
    },
  };
}

/** The Dynamic Graph planner/node (`@arch:GRAPHRUN`): graph capability, wake-up endpoint. */
function graphRow(): ChannelRow {
  return {
    kind: 'graph',
    cells: {
      // @arch:GRAPHRUN — `graph` / `node` run through the graph capability.
      commands: partial('graph / node', 'with the graph capability'),
      // @arch:GRAPHRUN — graph sessions are not wired for MCP.
      mcp: no('No', 'not wired for graph sessions'),
      // @arch:GRAPHRUN — wake-up is a POST to /graph-wakeup.
      hooks: partial('Wake-up', 'POST /graph-wakeup'),
      // @arch:GRAPHRUN — the node prompt is inlined into the launch.
      instructions: partial('Inline prompt'),
      // @arch:GRAPHRUN — no guide pointer for a graph session.
      guide: no('No'),
      // @arch:MAILBOX — a visit brief carries mail and notes into the next brief.
      mail: partial('Visit brief', 'mail and notes in the next brief'),
      // @arch:GRAPHRUN — no parent/sub-task mail for a graph session.
      parentMail: no('No'),
    },
  };
}

/** Headless runs — UAT tester, reviewer, classifiers (`@arch:AC-11`, `@arch:AC-44`). */
function headlessRow(): ChannelRow {
  return {
    kind: 'headless',
    cells: {
      // @arch:AC-11 — prompt in, stdout or a schema-conforming final document out.
      commands: no('No', 'prompt in, stdout or schema out'),
      // @arch:AC-44 — headless runs are isolated from MCP: strict zero.
      mcp: no('No', 'strict: zero MCP'),
      // @arch:AC-11 — no lifecycle hooks in a bounded headless run.
      hooks: no('No'),
      // @arch:AC-11 — no instruction layer: the prompt owns the rules.
      instructions: no('No'),
      // @arch:AC-11 — no guide pointer.
      guide: no('No'),
      // @arch:AC-11 — no mail route.
      mail: no('No'),
      // @arch:AC-11 — no parent/sub-task mail.
      parentMail: no('No'),
    },
  };
}

/**
 * Build the whole map for `providers`, in the order given. Every core-dependent
 * cell comes from the real adapter, never from a copied table, so a core's row
 * cannot disagree with its launch.
 */
export function buildChannelMap(providers: readonly AgentProvider[]): ChannelMapView {
  return {
    cores: providers.map((core) => {
      const adapter = resolveAdapter(core);
      return {
        core,
        rows: [ticketRow(core, adapter), sandboxRow(), planningRow(), setupRow(adapter), graphRow(), headlessRow()],
      };
    }),
  };
}

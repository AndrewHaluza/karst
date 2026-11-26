/**
 * The graph approach's configuration groups: Planner, Execution profiles and
 * the three limit subsections (Budgets, artifact/workspace ceilings,
 * concurrency ceilings).
 *
 * Moved verbatim out of the roster card with no behavior change — today the
 * card still renders these groups inside its `.graph-config` block. A later
 * change renders them inside the Edit drawer instead and turns them into the
 * Agents / Limits / Planner regions.
 *
 * The rules that are easy to lose, moved with the code:
 *
 * - a per-profile agent pick writes ONLY that profile's `provider`/`model`/
 *   `effort` in the draft entry — spread through `writeGraphProfile`, never a
 *   rebuilt `graph` block — and marks the approaches tab dirty the same way the
 *   enable toggle does (R26);
 * - every budget row is a real number input bound to one `graph.limits` field
 *   (vanilla's `data-gf-limit`), carrying the packaged default and the product
 *   hard ceiling beside it, both IMPORTED from `graphConfig.ts` (R-X1: a
 *   mirrored ceiling is a ceiling that can drift from the validator that
 *   enforces it). An emptied input DELETES the key — absence = packaged default
 *   at Save;
 * - the **prompt link** posts `open-graph-prompt` through `useHostMutation`
 *   (UI-R11): pending on activation, no second activation while in flight,
 *   settled by the host's `action-result` receipt. It is one mutation per
 *   rendered graph surface, because interaction state belongs to the control
 *   that owns it — a shared section-level hook would flag every sibling card's
 *   link busy (UI-R09b).
 */
import { useEffect, useRef } from 'react';
import type { ApproachDef } from '../../../../manifest/types.js';
import {
  DEFAULT_GRAPH_LIMITS,
  GRAPH_COMMAND_TIMEOUT_CEILING,
  GRAPH_HARD_CEILINGS,
} from '../../../../manifest/graphConfig.js';
import { useSettingsApp } from '../SettingsAppContext.js';
import { useHostMutation } from '../useHostMutation.js';
import type { AgentPickerIdentity, AgentPickerRoutes } from '../hostBridge.js';
import { Field } from '../primitives/Field.js';
import { AgentPickerIsland } from './AgentPickerIsland.js';
import { pickerCores } from './presetDraft.js';
import type { GraphLimitField } from './approachDraft.js';
import { budgetHint, formatSeconds } from './graphLimitUnits.js';

/**
 * The host's graph-prompt identity — the value vanilla hardcoded on
 * `data-open-graph-prompt`, which the host resolves to the packaged planner
 * artifact. A behavior value, but view-local in both implementations (the host
 * takes it as the message's `identity`), so it lives here rather than being
 * mirrored from a TS export that does not exist.
 */
const GRAPH_PROMPT_IDENTITY = 'karst-graph-planner';

/** The prompt link's text when the approach declares no artifact (vanilla copy). */
const FALLBACK_PROMPT_TEXT = 'graph-planner prompt';

/** Stable identity for "this row inherits nothing" — see `PresetsSection`. */
const NO_INHERIT: { readonly core?: string; readonly model?: string; readonly effort?: string } = {};

/** One budget row: the `data-gf-limit` field and the vanilla row label. */
interface LimitRowSpec {
  readonly field: GraphLimitField;
  readonly label: string;
}

/**
 * The limit rows vanilla's `renderGraphConfig` emitted, in its render order and
 * with its labels verbatim — the row list is the design of record, so it is
 * stated once here and each row imports its packaged default and hard ceiling
 * from `graphConfig.ts` (R-X1) rather than restating a number.
 */
const BUDGET_ROWS: readonly LimitRowSpec[] = [
  { field: 'maxGraphWallSeconds', label: 'Graph lifetime' },
  { field: 'maxAgentWallSeconds', label: 'Planner/agent wall time' },
  { field: 'maxAgentIdleSeconds', label: 'Agent idle time' },
];

const BYTE_ROWS: readonly LimitRowSpec[] = [
  { field: 'maxArtifactBytes', label: 'Per-artifact' },
  { field: 'maxLogBytes', label: 'Per-log' },
  { field: 'maxAggregateArtifactBytes', label: 'Aggregate artifacts' },
  { field: 'maxAggregateWorkspaceBytes', label: 'Aggregate workspace' },
];

const CEILING_ROWS: readonly LimitRowSpec[] = [
  { field: 'maxParallel', label: 'Max parallel processes' },
  { field: 'maxNodeRuns', label: 'Node runs' },
  { field: 'maxExpertRuns', label: 'Expert runs' },
  { field: 'maxReplans', label: 'Replans' },
  { field: 'maxActivations', label: 'Activations' },
];

export function GraphDrawerSections({
  approach,
  catalog,
  recent,
  cores,
  routes,
  onWriteProfile,
  onWriteLimit,
}: {
  readonly approach: ApproachDef;
  readonly catalog: unknown;
  readonly recent: Readonly<Record<string, readonly string[]>>;
  readonly cores: ReturnType<typeof pickerCores>;
  readonly routes: AgentPickerRoutes;
  /** Write one profile's identity into the draft entry (spread, not rebuild). */
  readonly onWriteProfile: (profile: string, identity: AgentPickerIdentity) => void;
  /** Write one limit field into the draft entry; `undefined` deletes the key. */
  readonly onWriteLimit: (field: GraphLimitField, value: number | undefined) => void;
}) {
  const { state, send } = useSettingsApp();

  // The prompt link's mutation, owned PER RENDERED SURFACE: two graph cards on
  // screen means two links, and interaction state belongs to the control that
  // owns it (R09b) — one section-level hook would flag a sibling card's link
  // busy too. `useHostMutation` is the ONLY owner of async lifecycle (R11–R15,
  // R17, R18): pending enters synchronously on activation, a second activation
  // while in flight posts nothing, and the terminal result comes from the
  // receipt below rather than a local flag.
  const openPrompt = useHostMutation<[]>({
    kind: 'Open graph prompt',
    send: (requestId) => send.openGraphPrompt(GRAPH_PROMPT_IDENTITY, requestId),
  });

  // Settle from the reducer's receipts — ONE direction of truth, exactly like
  // the drawer mutations: each receipt is consumed ONCE (the hook keeps
  // `requestId` for its whole life, so an effect that re-read it on every
  // render would re-fire the success branch forever).
  const receipts = state.receipts;
  const promptSettledRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const id = openPrompt.requestId;
    if (id === undefined || promptSettledRef.current.has(id)) return;
    const receipt = receipts[id];
    if (!receipt) return;
    promptSettledRef.current = new Set(promptSettledRef.current).add(id);
    openPrompt.settle({
      requestId: id,
      result: receipt.ok ? 'success' : 'failure',
      message: receipt.message ?? undefined,
    });
  }, [receipts, openPrompt]);

  const graph = approach.graph;
  if (!graph) return null;
  const profiles = graph.profiles ?? {};
  const limits = graph.limits;

  return (
    <div className="graph-config" data-graph-config={approach.id}>
      {/*
        Planner: the prompt link is the visible resource identifier (the
        packaged artifact path, UI-R09c) — link semantics, not a button —
        and it is host-mediated, so its click posts the shared
        pending-action runtime (UI-R11): pending on activation, no second
        activation while in flight, settled by the host's action-result
        receipt through the mutation above. `href="#"` keeps the anchor
        focusable and activatable exactly like the vanilla link.
      */}
      <div className="graph-subsection-title">Planner</div>
      <div className="graph-row">
        <a
          href="#"
          className="graph-prompt-link"
          data-open-graph-prompt={GRAPH_PROMPT_IDENTITY}
          title={graph.planner?.prompt?.artifact}
          aria-busy={openPrompt.pending || undefined}
          aria-disabled={openPrompt.disabled || undefined}
          onClick={(event) => {
            event.preventDefault();
            if (openPrompt.disabled) return;
            openPrompt.trigger();
          }}
        >
          {/* The full artifact path, not its basename: it is the visible
              resource identifier (UI-R09c) and must be readable before the
              file opens, never only in a mouse-only title (UI-R44). */}
          {graph.planner?.prompt?.artifact || FALLBACK_PROMPT_TEXT}
        </a>
      </div>
      {/* Execution profiles: each profile row hosts the UNIFIED agent
          identity picker (R-X3 island) — a pick re-filters the model list
          for THAT profile only, and writes only that profile through
          `onWriteProfile`. */}
      <div className="graph-subsection-title">Execution profiles</div>
      {Object.keys(profiles).length === 0 ? (
        <div className="k-empty">
          <div className="k-empty-title">No profiles configured.</div>
        </div>
      ) : (
        Object.keys(profiles).map((name) => (
          <div key={name} className="graph-row">
            <span className="graph-profile-name">{name}</span>
            <div className="graph-profile-picker" data-gf-profile-picker={name}>
              <AgentPickerIsland
                compact
                cores={cores}
                catalog={catalog}
                recent={recent}
                routes={routes}
                inherit={NO_INHERIT}
                value={{
                  core: (profiles[name]?.provider as string) || '',
                  model: profiles[name]?.model || '',
                  effort: profiles[name]?.effort || '',
                }}
                labels={{ core: 'Core', model: 'Model', effort: 'Effort' }}
                showEffort
                onChange={(identity) => onWriteProfile(name, identity)}
              />
            </div>
          </div>
        ))
      )}
      {/* Budgets, then the byte ceilings, then the concurrency ceilings —
          the three subsections vanilla's renderGraphConfig emitted, with
          one editable number input per limit field. The command timeout
          stays a HINT row: it is set per command, not here (and the
          React card does not yet render the command allowlist). */}
      <div className="graph-subsection-title">Budgets</div>
      {BUDGET_ROWS.map((row) => (
        <LimitRow
          key={row.field}
          row={row}
          value={limits?.[row.field]}
          onChange={(value) => onWriteLimit(row.field, value)}
        />
      ))}
      <div className="graph-row">
        <span className="graph-label">Command timeout</span>
        <span className="graph-hint">
          set per command below · hard ceiling {GRAPH_COMMAND_TIMEOUT_CEILING}{' '}
          ({formatSeconds(GRAPH_COMMAND_TIMEOUT_CEILING)})
        </span>
      </div>
      <div className="graph-subsection-title">Artifact and workspace ceilings</div>
      {BYTE_ROWS.map((row) => (
        <LimitRow
          key={row.field}
          row={row}
          value={limits?.[row.field]}
          onChange={(value) => onWriteLimit(row.field, value)}
        />
      ))}
      <div className="graph-subsection-title">Concurrency and budget ceilings</div>
      {CEILING_ROWS.map((row) => (
        <LimitRow
          key={row.field}
          row={row}
          value={limits?.[row.field]}
          onChange={(value) => onWriteLimit(row.field, value)}
        />
      ))}
    </div>
  );
}

/**
 * One numeric budget row — the React form of vanilla's `graphLimitRowHtml`.
 *
 * The vanilla row was a raw `<input data-gf-limit … aria-label>`; the static
 * guard wins over that markup: a raw `<input>` is banned outside `primitives/`
 * (architecture.test R07/R08) and `Field` is the one owner of the label ↔
 * control pairing (UI-R25). So the control rides `Field` — its label IS the
 * accessible name, the same string vanilla put in `aria-label`, wired through
 * `for`/`id` instead — and the vanilla `data-gf-limit` / `data-packaged` /
 * `data-ceiling` hooks live on the ROW that owns that input, where a test (and
 * any parity sweep) can still address them per field.
 *
 * The input is CONTROLLED by the draft: an absent key renders empty — absence
 * is the packaged default, exactly vanilla's valueless input — and a present
 * override renders as written (React cannot echo keystrokes back through an
 * uncontrolled node once the draft is the source of truth). Clearing the input
 * writes `undefined`, which `writeGraphLimit` turns into a DELETED key.
 */
function LimitRow({
  row,
  value,
  onChange,
}: {
  readonly row: LimitRowSpec;
  readonly value: number | undefined;
  readonly onChange: (value: number | undefined) => void;
}) {
  const packaged = DEFAULT_GRAPH_LIMITS[row.field];
  const ceiling = GRAPH_HARD_CEILINGS[row.field];
  return (
    <div
      className="graph-row"
      data-gf-limit={row.field}
      data-packaged={String(packaged)}
      data-ceiling={String(ceiling)}
    >
      <Field
        label={row.label}
        control={{
          kind: 'input',
          type: 'number',
          name: `gf-limit-${row.field}`,
          value: value === undefined ? '' : String(value),
          onChange: (raw) => {
            // The vanilla input listener's rule, per keystroke: empty DELETES
            // the key (absence = packaged default at Save); anything else is
            // handed to the host as typed — the webview never coerces, because
            // validateGraphConfig is the one that refuses a non-integer or a
            // ceiling violation with a named error.
            const text = raw.trim();
            onChange(text === '' ? undefined : Number(text));
          },
        }}
      />
      <span className="graph-hint">{budgetHint(row.field, packaged, ceiling)}</span>
    </div>
  );
}

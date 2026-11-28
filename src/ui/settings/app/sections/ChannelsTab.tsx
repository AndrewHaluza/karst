/**
 * The Channels tab of the Agents page (`@arch:CHANNEL-MAP`, P78/D841).
 *
 * A READ-ONLY map: for the chosen agent core it shows, per session kind, which
 * of karst's channels that session gets and why. Nothing here switches a
 * channel — karst decides each cell at launch, and the commands/signals layers
 * are host-owned, so a toggle would only break runs.
 *
 * Every fact comes from the host's `state.channels` (`buildChannelMap`, built
 * from the real adapters and delivery sources); this file only lays it out. The
 * three sections follow the prototype (`@ui:UI-R39`): the three-layer legend,
 * the core picker, then the map table. Below a 700 px container each map row
 * stacks into the prototype's narrow form (`@ui:UI-R43`).
 */
import { useSettingsApp } from '../SettingsAppContext.js';
import { SegmentedControl } from '../primitives/SegmentedControl.js';
import type { AgentProvider } from '../../../../manifest/types.js';
import type { ChannelColumn, ChannelMapCore, SessionKind } from '../../channelMap.js';
import type { AgentsRoute } from './agentsRoute.js';

const COLUMNS: readonly ChannelColumn[] = ['commands', 'mcp', 'hooks', 'instructions', 'guide', 'mail', 'parentMail'];

const COLUMN_LABELS: Readonly<Record<ChannelColumn, string>> = {
  commands: 'Commands',
  mcp: 'Karst MCP',
  hooks: 'Hooks',
  instructions: 'Instruction layer',
  guide: 'Guide pointer',
  mail: 'Mail pointers',
  parentMail: 'Parent / sub-task mail',
};

const SESSION_LABELS: Readonly<Record<SessionKind, string>> = {
  ticket: 'Ticket session',
  sandbox: 'Ticket session in a sandbox backend',
  planning: 'Planning session',
  setup: 'Setup session',
  graph: 'Dynamic Graph planner / node',
  headless: 'Headless: UAT tester, reviewer, classifiers',
};

/** The prototype's short core names (`@ui:UI-R39`), not the manifest's long labels. */
const CORE_LABELS: Readonly<Record<AgentProvider, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
  opencode2: 'OpenCode v2',
};

export interface ChannelsTabProps {
  readonly route: AgentsRoute;
  readonly navigate: (route: AgentsRoute) => void;
}

export function ChannelsTab({ route, navigate }: ChannelsTabProps) {
  const { state } = useSettingsApp();
  const view = state.host?.channels;
  if (view === undefined || view.cores.length === 0) {
    // A hand-written fixture (tests/visual/corpora.ts MINIMAL_SETTINGS) has no
    // channels: say so in one muted line instead of crashing the page.
    return (
      <div className="channels-tab">
        <p className="accounts-hint">No channel data.</p>
      </div>
    );
  }

  // An unknown core in the hash keeps its value, but the map shows the first
  // core rather than an empty table (a stale link must never blank the tab).
  const requested = route.selected;
  const selected = requested !== undefined && view.cores.some((entry) => entry.core === requested)
    ? requested
    : view.cores[0]!.core;
  const entry: ChannelMapCore = view.cores.find((candidate) => candidate.core === selected) ?? view.cores[0]!;

  return (
    <div className="channels-tab">
      <section className="channels-section" data-region="channels-layers" aria-labelledby="channels-layers-title">
        <h3 className="channels-title" id="channels-layers-title">How agents talk to Karst</h3>
        <div className="channels-layers">
          <div>
            <b>Commands</b>
            <span>
              The agent calls Karst: the Karst MCP tools, or <code>node "$KARST_CLI"</code>, or the bridge files in a
              sandbox. Same handlers; Karst picks the transport.
            </span>
          </div>
          <div>
            <b>Signals</b>
            <span>Karst watches the agent: lifecycle hooks, a plugin, or the agent's own conversation store.</span>
          </div>
          <div>
            <b>Messages</b>
            <span>
              Karst and other agents reach the agent: the instruction layer, the guide pointer, mail and brief pointers,
              parent and sub-task mail.
            </span>
          </div>
        </div>
      </section>

      <section className="channels-section" data-region="channels-core" aria-labelledby="channels-core-title">
        <h3 className="channels-title" id="channels-core-title">Agent core</h3>
        <p className="accounts-hint channels-help">
          The map shows what a session on this core gets. Karst decides each cell at launch; there is nothing to switch
          here.
        </p>
        <SegmentedControl
          labelId="channels-core-title"
          value={selected}
          options={view.cores.map((candidate) => ({ value: candidate.core, label: CORE_LABELS[candidate.core] }))}
          onChange={(core) => navigate({ tab: 'channels', selected: core })}
          className="channels-core"
        />
      </section>

      <section className="channels-section" data-region="channels-map" aria-labelledby="channels-map-title">
        <h3 className="channels-title" id="channels-map-title">Channels by session kind</h3>
        <table className="channels-map">
          <thead>
            <tr>
              <th scope="col">Session kind</th>
              {COLUMNS.map((column) => (
                <th key={column} scope="col">{COLUMN_LABELS[column]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entry.rows.map((row) => (
              <tr key={row.kind}>
                <th scope="row" className="channels-kind">{SESSION_LABELS[row.kind]}</th>
                {COLUMNS.map((column) => {
                  const cell = row.cells[column];
                  return (
                    <td key={column} data-col={COLUMN_LABELS[column]}>
                      <span className={`channels-cell is-${cell.state}`}>
                        <span className="channels-value">{cell.value}</span>
                        {cell.reason === undefined ? null : <span className="channels-reason">{cell.reason}</span>}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

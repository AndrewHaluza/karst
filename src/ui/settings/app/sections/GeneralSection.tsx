/**
 * The General tab (NDL-126 §8.3, phase 3 step 2, first of four).
 *
 * `SECTION_FIELDS.general` in `src/ui/settings/sections.ts` is the authority for
 * what this tab owns: thirteen keys. Anything it does not claim — `id`, most
 * importantly — is never editable here and always survives from the file, which
 * is why every editor below writes exactly one claimed key and nothing else.
 *
 * Ported one-to-one from the inline `renderGeneral()` + its listeners. The copy,
 * the placeholders, the help strings, the toggle-delete-on-uncheck rule and the
 * two number-input quirks are the vanilla ones, not restyled ones:
 *
 * - a cleared optional template DELETES the key (that is how a template is
 *   unset) rather than writing an empty string;
 * - `portRange` is a 2-tuple, so its min and max are two inputs writing one
 *   key, and `archiveDoneAfterDays` snaps back to blank when it is not a
 *   positive integer;
 * - the three agent-identity keys (`agentProvider`, `defaultModel`,
 *   `defaultEffort`) are ONE picker, not three selects, so it is mounted as an
 *   opaque island (R-X3) rather than rebuilt out of primitives.
 */
import { useMemo } from 'react';
import type {
  AgentProvider,
  Manifest,
  WorktreePathDisplay,
} from '../../../../manifest/types.js';
import { AGENT_PROVIDER_LABELS, KNOWN_AGENT_PROVIDERS } from '../../../../model/agentProviders.js';
import {
  DEFAULT_TERMINAL_NAME_TEMPLATE,
  DEFAULT_TICKET_LABEL_TEMPLATE,
  TICKET_LABEL_VARIABLES,
} from '../../../../store/ticketLabelTemplate.js';
import { readField, useSettingsApp } from '../SettingsAppContext.js';
import { Field } from '../primitives/Field.js';
import { AgentPickerIsland } from './AgentPickerIsland.js';

/** The one inherit row the General picker leads with, as the vanilla view pins it. */
const PICKER_INHERIT = {
  core: '',
  model: 'No default (agent picks)',
  effort: 'No effort (agent picks)',
} as const;

/** The default `worktreePathDisplay` the host validator falls back to. */
const WORKTREE_DISPLAY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'relative', label: 'relative' },
  { value: 'absolute', label: 'absolute' },
];

/** Write one claimed key, leaving every other field of the draft alone. */
function set<K extends keyof Manifest>(key: K, value: Manifest[K] | undefined): (draft: Manifest) => Manifest {
  return (draft) => {
    const next = { ...draft };
    // An emptied optional field is REMOVED, exactly as `mergeSection` does on
    // the host — that is how an optional template gets cleared.
    if (value === undefined) delete next[key];
    else next[key] = value;
    return next;
  };
}

export function GeneralSection() {
  const { state, edit } = useSettingsApp();
  const draft = state.draft;

  const setPortBound = useMemo(
    () =>
      (bound: 0 | 1) =>
      (raw: string): void => {
        const current = readField<readonly number[]>(draft, 'portRange', [4000, 4999]);
        const min = Number(current[0]) || 0;
        const max = Number(current[1]) || 0;
        const next: [number, number] = bound === 0 ? [Number(raw) || 0, max] : [min, Number(raw) || 0];
        edit(set('portRange', next));
      },
    [draft, edit],
  );

  // `archiveDoneAfterDays` is blankable, so the control is driven by a STRING and
  // the manifest only ever holds a positive integer: anything else clears the key
  // and the field renders blank again, which is the vanilla snap-back.
  const archiveRaw = readField<number | undefined>(draft, 'archiveDoneAfterDays', undefined);
  const archiveText = archiveRaw === undefined ? '' : String(archiveRaw);

  const portRange = readField<readonly number[]>(draft, 'portRange', [4000, 4999]);

  // Memoise every island input: the island rebuilds on an input change, so an
  // unstable object here would tear the shared runtime down on every render.
  const pickerCatalog = useMemo(() => state.models?.models ?? {}, [state.models]);
  const pickerRecent = useMemo(() => state.models?.recentModels ?? {}, [state.models]);
  const pickerValue = useMemo(
    () => ({
      core: readField<string>(draft, 'agentProvider', ''),
      model: readField<string>(draft, 'defaultModel', ''),
      effort: readField<string>(draft, 'defaultEffort', ''),
    }),
    [draft],
  );

  const pickerCores = useMemo(
    () =>
      KNOWN_AGENT_PROVIDERS.map((provider) => ({
        id: provider,
        label: AGENT_PROVIDER_LABELS[provider] ?? provider,
        disabled: !state.implementedProviders.includes(provider),
      })),
    [state.implementedProviders],
  );

  const setArchiveDays = (raw: string): void => {
    const parsed = Number(raw);
    edit(set('archiveDoneAfterDays', Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined));
  };

  const setToggle = (key: 'debug' | 'closeDoneTerminalsWithTicket' | 'diffsInSourceControl') =>
    (checked: boolean): void => {
      edit(set(key, checked ? true : undefined));
    };

  const setIdentity = (next: {
    core: string;
    model: string;
    effort: string;
  }): void => {
    const core = next.core as AgentProvider | '';
    // The picker writes each of the three keys independently: unchecking effort
    // must not clear the chosen model. An empty selection clears its own key.
    edit((current) => ({
      ...current,
      agentProvider: core || undefined,
      defaultModel: next.model || undefined,
      defaultEffort: next.effort || undefined,
    }));
  };

  return (
    <div className="section" id="section-general">
      <div className="page-header">
        <div className="page-title">General</div>
        <div className="page-desc">
          Project defaults Karst applies to every run, and the shared agent this project launches by
          default.
        </div>
      </div>

      <div className="section-block">
        <div className="section-head">
          <div>
            <div className="section-title">Project defaults</div>
            <div className="section-desc">
              Where worktrees land, which branch they are cut from, and the ports Karst may hand out.
            </div>
          </div>
        </div>
        <div className="form-grid">
          <Field
            label="Host"
            control={{
              kind: 'input',
              name: 'host',
              value: readField<string>(draft, 'host', ''),
              placeholder: 'localhost',
              onChange: (value) => edit(set('host', value)),
            }}
          />
          <Field
            label="Port range"
            help="Pool Karst may allocate when starting services."
            control={{
              kind: 'pair',
              first: {
                name: 'portRangeMin',
                type: 'number',
                value: String(portRange[0] ?? ''),
                placeholder: 'min',
                onChange: setPortBound(0),
              },
              second: {
                name: 'portRangeMax',
                type: 'number',
                value: String(portRange[1] ?? ''),
                placeholder: 'max',
                ariaLabel: 'Port range maximum',
                onChange: setPortBound(1),
              },
            }}
          />
          <Field
            label="Baseline branch"
            control={{
              kind: 'input',
              name: 'baselineBranch',
              value: readField<string>(draft, 'baselineBranch', ''),
              placeholder: 'main',
              onChange: (value) => edit(set('baselineBranch', value)),
            }}
          />
          <Field
            label="Worktree path display"
            control={{
              kind: 'select',
              name: 'worktreePathDisplay',
              value: readField<WorktreePathDisplay>(draft, 'worktreePathDisplay', 'relative'),
              options: WORKTREE_DISPLAY_OPTIONS,
              onChange: (value) =>
                edit(set('worktreePathDisplay', value as WorktreePathDisplay)),
            }}
          />
        </div>
      </div>

      <div className="section-block">
        <div className="section-head">
          <div>
            <div className="section-title">Default implementation agent</div>
          </div>
        </div>
        <div className="form-grid">
          <div className="field-label">Default implementation agent</div>
          <div className="field-control">
            <AgentPickerIsland
              cores={pickerCores}
              catalog={pickerCatalog}
              recent={pickerRecent}
              value={pickerValue}
              inherit={PICKER_INHERIT}
              showEffort
              onChange={setIdentity}
            />
            <span className="k-field-help">
              Used for normal implementation sessions. “No default” lets the provider choose. Effort
              / variant appears only for models that advertise it. Inside process assignments are
              configured on the Agents page.
            </span>
          </div>
        </div>
      </div>

      <div className="section-block">
        <div className="section-head">
          <div>
            <div className="section-title">Display templates</div>
            <div className="section-desc">
              How a ticket label and a terminal name read once Karst names them.
            </div>
          </div>
        </div>
        <div className="form-grid">
          <Field
            label="Ticket label template"
            control={{
              kind: 'input',
              name: 'ticketLabelTemplate',
              value: readField<string>(draft, 'ticketLabelTemplate', ''),
              // The host's own default (R-X1: import, never mirror) — a drift
              // here would show Settings a default the engine does not use.
              placeholder: DEFAULT_TICKET_LABEL_TEMPLATE,
              onChange: (value) => edit(set('ticketLabelTemplate', value || undefined)),
            }}
            help="Leave blank to keep the built-in label format."
          />
          <Field
            label="Terminal name template"
            control={{
              kind: 'input',
              name: 'terminalNameTemplate',
              value: readField<string>(draft, 'terminalNameTemplate', ''),
              placeholder: DEFAULT_TERMINAL_NAME_TEMPLATE,
              onChange: (value) => edit(set('terminalNameTemplate', value || undefined)),
            }}
            help="Leave blank to keep the built-in terminal name."
          />
          {/*
            The shared variable set, IMPORTED from the same host module the
            label engine uses (UI-R34). The follow-up marker is deliberately
            absent: `parentTicketId` is presentation metadata forced at the
            terminal seam, never a template token.
          */}
          <div className="field-control label-vars">
            {`Variables: ${TICKET_LABEL_VARIABLES.map((name) => `{${name}}`).join(' ')}`}
          </div>
        </div>
      </div>

      <div className="section-block">
        <div className="section-head">
          <div>
            <div className="section-title">Housekeeping</div>
            <div className="section-desc">
              What Karst tidies up on its own, and what it shows you while you work.
            </div>
          </div>
        </div>
        <div className="form-grid">
          <Field
            label="Archive done tickets after"
            help="Blank = the 3-day default. Karst never archives a ticket the moment it merges."
            control={{
              kind: 'input',
              name: 'archiveDoneAfterDays',
              type: 'number',
              value: archiveText,
              onChange: setArchiveDays,
            }}
          />
          <Field
            label="Debug logging"
            help="Writes Karst's internal decisions to the Karst output channel and to diagnostic reports."
            control={{
              kind: 'checkbox',
              name: 'debug',
              checked: readField<boolean>(draft, 'debug', false),
              onChange: setToggle('debug'),
            }}
          />
          <Field
            label="Close done terminals with ticket"
            help="Closing a terminal whose ticket is done also closes its archived worktree."
            control={{
              kind: 'checkbox',
              name: 'closeDoneTerminalsWithTicket',
              checked: readField<boolean>(draft, 'closeDoneTerminalsWithTicket', false),
              onChange: setToggle('closeDoneTerminalsWithTicket'),
            }}
          />
          <Field
            label="Show changes in Source Control"
            help="Lists each ticket's branch as a Source Control view so the diff is one click away."
            control={{
              kind: 'checkbox',
              name: 'diffsInSourceControl',
              checked: readField<boolean>(draft, 'diffsInSourceControl', false),
              onChange: setToggle('diffsInSourceControl'),
            }}
          />
        </div>
      </div>
    </div>
  );
}

/** The provider ids the picker offers, for a host that only knows some of them. */
export function offeredProviders(implemented: readonly AgentProvider[]): readonly AgentProvider[] {
  return KNOWN_AGENT_PROVIDERS.filter((provider) => implemented.includes(provider));
}

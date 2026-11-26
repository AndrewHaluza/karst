/**
 * The Ticketing tab's "Behavior" section (T1371/D831).
 *
 * Four rows, all ClickUp-only, in the shared row grammar: the Add-ticket search
 * toggle, the sub-task mode, and one status select per advance point. The
 * sub-task help shows ONLY the selected mode's meaning; each status select
 * carries its own hint (a missing prerequisite, loading, failed, empty or stale
 * copy) and "Don't change" as its first option.
 */
import type { ReactElement } from 'react';
import type { SyncSubtasksMode } from '../../../../manifest/types.js';
import { Field } from '../primitives/Field.js';
import { SegmentedControl, type SegmentedOption } from '../primitives/SegmentedControl.js';
import {
  FieldHelp,
  TicketingRow,
} from './TicketingRows.js';
import {
  SEARCH_HELP,
  SUBTASKS_LABEL,
  SUBTASK_HELP,
  type DerivedSelect,
} from './ticketingDerive.js';

const SUBTASK_OPTIONS: readonly SegmentedOption[] = [
  { value: 'off', label: 'Off' },
  { value: 'link', label: 'Link' },
  { value: 'full', label: 'Full' },
];

export interface StatusRowSpec {
  readonly label: string;
  readonly help: string;
  readonly name: string;
  readonly view: DerivedSelect;
  /** The select's value: the saved status only while the matching flag is on. */
  readonly value: string;
  readonly onChange: (value: string) => void;
}

export interface TicketingBehaviorProps {
  readonly searchEnabled: boolean;
  readonly onSearch: (checked: boolean) => void;
  readonly syncSubtasks: SyncSubtasksMode;
  readonly onSyncSubtasks: (mode: SyncSubtasksMode) => void;
  readonly start: StatusRowSpec;
  readonly ship: StatusRowSpec;
}

export function TicketingBehavior({
  searchEnabled,
  onSearch,
  syncSubtasks,
  onSyncSubtasks,
  start,
  ship,
}: TicketingBehaviorProps): ReactElement {
  const subtasksLabelId = 'ticketingSubtasksLabel';
  return (
    <section
      className="ticketing-section"
      data-region="ticketing-behavior"
      aria-labelledby="ticketing-behavior-title"
    >
      <div className="ticketing-head">
        <h3 id="ticketing-behavior-title">Behavior</h3>
      </div>
      <div className="ticketing-rows">
        <Field
          className="ticketing-row"
          label="Search tickets in Add ticket"
          help={SEARCH_HELP}
          control={{
            kind: 'checkbox',
            name: 'searchEnabled',
            checked: searchEnabled,
            onChange: onSearch,
          }}
        />

        <TicketingRow label={SUBTASKS_LABEL} labelId={subtasksLabelId} help={SUBTASK_HELP[syncSubtasks]}>
          <SegmentedControl
            labelId={subtasksLabelId}
            value={syncSubtasks}
            options={SUBTASK_OPTIONS}
            onChange={(value) => onSyncSubtasks(value as SyncSubtasksMode)}
          />
        </TicketingRow>

        <Field
          className="ticketing-row"
          label={start.label}
          help={<FieldHelp hint={start.view.hint} help={start.help} />}
          control={{
            kind: 'select',
            name: start.name,
            value: start.value,
            disabled: start.view.controlDisabled,
            options: start.view.options,
            onChange: start.onChange,
          }}
        />
        <Field
          className="ticketing-row"
          label={ship.label}
          help={<FieldHelp hint={ship.view.hint} help={ship.help} />}
          control={{
            kind: 'select',
            name: ship.name,
            value: ship.value,
            disabled: ship.view.controlDisabled,
            options: ship.view.options,
            onChange: ship.onChange,
          }}
        />
      </div>
    </section>
  );
}

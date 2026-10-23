/**
 * The Roles table rows. A normal row is editable: the picker writes the layer
 * that wins (`writeRole`), the chip says which layer that is, and pin / clear
 * move the value between layers. A compare row is read-only: A and B EFFECTIVE
 * values side by side with the differences marked and "← Copy from B".
 */
import { useMemo } from 'react';
import { PROMPT_BEARING_PROCESS_KEYS, type ProcessKey } from '../../../../manifest/validate/processAssignments.js';
import type { SettingsProcessAssignmentView } from '../../processAssignmentViews.js';
import { AgentPickerIsland } from './AgentPickerIsland.js';
import { Button } from '../primitives/Button.js';
import { Chip } from '../primitives/Chip.js';
import { Field } from '../primitives/Field.js';
import { IconButton } from '../primitives/IconButton.js';
import { KarstMark } from '../primitives/KarstMark.js';
import { Switch } from '../primitives/Switch.js';
import { TablerIcon } from '../primitives/TablerIcon.js';
import { NO_INHERIT, usePickerInputs } from './usePickerInputs.js';
import { pinKeyOf, type EffectiveRole, type RoleValue } from './rolesModel.js';

export const SOURCE_TEXT: Readonly<Record<EffectiveRole['source'], { chip: string; label: string; why: string }>> = {
  pin: { chip: 'pinned', label: 'Pinned', why: 'Pinned: the same in all presets, and it beats the preset.' },
  preset: { chip: 'preset', label: 'Preset', why: 'From the selected preset.' },
  default: { chip: 'default', label: 'Karst default', why: "No preset value and no pin: uses Karst's built-in default." },
};

/** The Source cell chip. A Karst default carries the mark and a screen-reader label. */
function SourceCell({ source }: { readonly source: EffectiveRole['source'] }) {
  const t = SOURCE_TEXT[source];
  if (source === 'default') {
    return (
      <span title={`${t.label}. ${t.why}`} data-source={source}>
        <Chip>
          <KarstMark size={12} />
          <span aria-hidden="true">{t.chip}</span>
          <span className="sr-only">{t.label}</span>
        </Chip>
      </span>
    );
  }
  return (
    <span title={t.why} data-source={source}>
      <Chip tone={source === 'pin' ? 'success' : 'neutral'}>
        <TablerIcon name={source === 'pin' ? 'pin' : 'stack-2'} size={12} />
        <span>{t.chip}</span>
      </Chip>
    </span>
  );
}

export const roleText = (v: RoleValue): string =>
  [v.core, v.model, v.effort].filter((part) => part !== '').join(' · ') || '—';

export interface RoleRowProps {
  readonly capability: string;
  readonly label: string;
  readonly effective: EffectiveRole;
  readonly view: SettingsProcessAssignmentView | undefined;
  readonly profile: string;
  readonly enabled: boolean;
  readonly selected: boolean;
  readonly flash: boolean;
  readonly sharesProfile: boolean;
  readonly onChange: (value: RoleValue) => void;
  readonly onPin: () => void;
  readonly onUnpin: () => void;
  readonly onClear: () => void;
  readonly onProfile: (name: string) => void;
  readonly onEnabled: (enabled: boolean) => void;
  readonly onOpenProfile: (name: string | null) => void;
}

/** The Agent profile cell: select + link into the Agent profiles tab. */
function ProfileCell({
  capability,
  view,
  profile,
  sharesProfile,
  onProfile,
  onOpenProfile,
}: Pick<RoleRowProps, 'capability' | 'view' | 'profile' | 'sharesProfile' | 'onProfile' | 'onOpenProfile'>) {
  const options = useMemo(() => {
    const listed = view?.profileOptions ?? [];
    const kept = profile !== '' && !listed.includes(profile) ? [profile] : [];
    return [
      { value: '', label: 'default' },
      ...[...kept, ...listed].map((name) => ({ value: name, label: name })),
    ];
  }, [view?.profileOptions, profile]);
  const key = pinKeyOf(capability);
  if (key === undefined) return <span className="agents-muted">—</span>;
  const builtIn = profile === '';
  const promptBearing = PROMPT_BEARING_PROCESS_KEYS.includes(key as ProcessKey);
  return (
    <div className="agents-profile-cell">
      <span className="agents-field-label" aria-hidden="true">Agent profile</span>
      <div className="agents-profile-fields">
        <div className={`agents-profile-select${builtIn ? ' has-mark' : ''}`}>
          {builtIn ? <KarstMark /> : null}
          <Field
            label={`Agent profile for ${view?.roleLabel ?? capability}`}
            hideLabel
            error={view?.invalidField === 'agent' ? view.stateMessage : undefined}
            control={{ kind: 'select', name: `role-${capability}-profile`, value: profile, options, onChange: onProfile }}
          />
        </div>
        <IconButton
          label={builtIn ? (promptBearing ? 'Open Karst built-in prompt' : 'Open Karst built-in profile') : `Open profile ${profile}`}
          onClick={() => onOpenProfile(builtIn ? null : profile)}
        >
          {builtIn ? <KarstMark /> : <TablerIcon name="file-text" />}
        </IconButton>
        {sharesProfile ? (
          <span
            className="agents-shared-icon"
            title="Shares this profile with the selected role"
          >
            <TablerIcon name="share" />
            <span className="sr-only">Shares this profile with the selected role</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function RoleRow(props: RoleRowProps) {
  const { capability, label, effective, selected, flash, sharesProfile } = props;
  const { catalog, recent, cores } = usePickerInputs();
  const pinnable = pinKeyOf(capability) !== undefined;
  const classes = [
    'agents-row',
    selected ? 'is-selected' : '',
    flash ? 'is-flash' : '',
    sharesProfile ? 'is-shared' : '',
    effective.source === 'default' ? 'is-inherited' : '',
    props.enabled ? '' : 'is-disabled',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={classes} data-role={capability} role="row">
      <div className="agents-cell agents-cell-switch" role="cell">
        {pinnable ? (
          <Switch
            name={`role-${capability}-enabled`}
            checked={props.enabled}
            label={props.enabled ? `Disable ${label}` : `Enable ${label}`}
            onChange={props.onEnabled}
          />
        ) : null}
      </div>
      <div className="agents-cell agents-cell-role" role="cell">
        <span className="agents-role-name">{label}</span>
      </div>
      <div className="agents-cell agents-cell-profile" role="cell">
        <ProfileCell {...props} />
      </div>
      <div className="agents-cell agents-cell-picker" role="cell">
        <AgentPickerIsland
          cores={cores}
          catalog={catalog}
          recent={recent}
          inherit={NO_INHERIT}
          value={{ core: effective.core, model: effective.model, effort: effective.effort }}
          labels={{ core: 'Core', model: 'Model', effort: 'Effort' }}
          showEffort
          compact
          onChange={props.onChange}
        />
      </div>
      <div className="agents-cell agents-cell-source" role="cell">
        <span className="agents-field-label" aria-hidden="true">Source</span>
        <SourceCell source={effective.source} />
      </div>
      <div className="agents-cell agents-cell-actions" role="cell">
        {pinnable ? (
          effective.source === 'pin' ? (
            <IconButton label="Unpin" onClick={props.onUnpin}>
              <TablerIcon name="pinned-off" />
            </IconButton>
          ) : (
            <IconButton label="Pin" disabled={effective.core === ''} onClick={props.onPin}>
              <TablerIcon name="pin" />
            </IconButton>
          )
        ) : (
          <span className="agents-slot" aria-hidden="true" />
        )}
        <IconButton label="Clear override" disabled={effective.source === 'default'} onClick={props.onClear}>
          <TablerIcon name="eraser" />
        </IconButton>
      </div>
    </div>
  );
}

export interface CompareRowProps {
  readonly capability: string;
  readonly label: string;
  readonly a: EffectiveRole;
  readonly b: EffectiveRole;
  readonly differs: boolean;
  readonly aName: string;
  readonly bName: string;
  readonly onCopy: () => void;
}

export function CompareRow({ capability, label, a, b, differs, aName, bName, onCopy }: CompareRowProps) {
  return (
    <div className={`agents-row agents-compare-row${differs ? ' differs' : ' same'}`} data-role={capability} role="row">
      <div className="agents-cell agents-cell-switch" role="cell" />
      <div className="agents-cell agents-cell-role" role="cell">
        {differs ? <span className="agents-change-dot" title="Differs" aria-label="differs" /> : null}
        <span className="agents-role-name">{label}</span>
      </div>
      <div className="agents-cell" role="cell">
        <span className="agents-field-label">A: {aName}</span>
        <span className="agents-a">{roleText(a)}</span>
        <SourceCell source={a.source} />
      </div>
      <div className="agents-cell" role="cell">
        <span className="agents-field-label">B: {bName}</span>
        <span className="agents-b">{roleText(b)}</span>
        <SourceCell source={b.source} />
        {a.source === 'pin' && b.source === 'pin' ? (
          <span className="agents-muted">pinned — same in all presets</span>
        ) : null}
      </div>
      <div className="agents-cell agents-cell-actions" role="cell">
        {differs && a.source !== 'pin' ? (
          <Button variant="ghost" size="sm" onClick={onCopy}>
            <TablerIcon name="arrow-left" /> Copy from {bName}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

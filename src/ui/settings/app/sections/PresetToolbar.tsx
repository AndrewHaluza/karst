/**
 * The preset toolbar: the selector plus New / Duplicate / Rename / Delete /
 * Activate. A preset's `active` mark sits on the selector's option and a badge
 * replaces Activate for the active one. Refusals (a referenced preset, a
 * duplicate name) show on one fault line under the bar — the draft is never
 * written by a refused op.
 */
import { useState, type ReactNode } from 'react';
import type { Manifest } from '../../../../manifest/types.js';
import { Button } from '../primitives/Button.js';
import { Chip } from '../primitives/Chip.js';
import { Field } from '../primitives/Field.js';
import { InlineTextInput } from '../primitives/InlineTextInput.js';
import { TablerIcon } from '../primitives/TablerIcon.js';
import { activatePreset, addPreset, deletePreset, duplicatePreset, renamePreset, type PresetOpResult } from './presetOps.js';

export interface PresetToolbarProps {
  readonly draft: Manifest;
  readonly lastSaved: Manifest | undefined;
  readonly names: readonly string[];
  readonly selected: string | null;
  readonly activeName: string;
  readonly roleLabelOf: (key: string) => string | undefined;
  readonly onSelect: (name: string | null) => void;
  readonly edit: (update: (draft: Manifest) => Manifest) => void;
  readonly compareSlot?: ReactNode;
}

export function PresetToolbar({
  draft,
  lastSaved,
  names,
  selected,
  activeName,
  roleLabelOf,
  onSelect,
  edit,
  compareSlot,
}: PresetToolbarProps) {
  const [fault, setFault] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);

  /** Apply an op's result: write the draft and follow the preset, or show why not. */
  const apply = (result: PresetOpResult, follow: boolean): boolean => {
    if (!result.ok) {
      setFault(result.error);
      return false;
    }
    setFault(null);
    edit(() => result.draft);
    if (follow) onSelect(result.name);
    return true;
  };

  const isActive = selected !== null && selected === activeName;
  const options = names.map((n) => ({ value: n, label: n }));

  return (
    <div className="agents-toolbar">
      <div className="agents-toolbar-row">
        <div className="agents-tgroup" role="group" aria-label="Preset">
          {renaming && selected !== null ? (
            <InlineTextInput
              initialValue={selected}
              label="Preset name"
              onCancel={() => setRenaming(false)}
              onCommit={(value) => apply(renamePreset(draft, lastSaved, selected, value, roleLabelOf), true)}
            />
          ) : (
            <Field
              label="Presets"
              help={isActive ? <span className="sr-only">active</span> : undefined}
              control={{
                kind: 'select',
                name: 'agents-preset',
                value: selected ?? '',
                ariaDescription: isActive ? 'active' : undefined,
                options: names.length === 0 ? [{ value: '', label: 'No presets yet' }] : options,
                disabled: names.length === 0,
                onChange: (value) => {
                  setFault(null);
                  onSelect(value === '' ? null : value);
                },
              }}
            />
          )}
          {isActive ? (
            <Chip tone="success">active</Chip>
          ) : selected !== null ? (
            <Button
              variant="primary"
              size="lg"
              onClick={() => {
                setFault(null);
                edit((current) => activatePreset(current, selected));
              }}
            >
              Activate
            </Button>
          ) : null}
        </div>
        <div className="agents-tgroup" role="group" aria-label="Edit preset">
          <Button variant="secondary" size="lg" onClick={() => apply(addPreset(draft), true)}>
            New
          </Button>
          <Button
            variant="ghost"
            size="lg"
            disabled={selected === null}
            onClick={() => selected !== null && apply(duplicatePreset(draft, selected), true)}
          >
            Duplicate
          </Button>
          <Button variant="ghost" size="lg" disabled={selected === null} onClick={() => setRenaming(true)}>
            Rename
          </Button>
        </div>
        {compareSlot}
        <div className="agents-tgroup agents-tgroup--end" role="group" aria-label="Delete preset">
          <Button
            variant="danger"
            size="lg"
            disabled={selected === null}
            onClick={() => {
              if (selected === null) return;
              if (apply(deletePreset(draft, lastSaved, selected, roleLabelOf), false)) onSelect(null);
            }}
          >
            <TablerIcon name="trash" />
            Delete preset
          </Button>
        </div>
      </div>
      {fault !== null ? (
        <div className="agents-fault" role="alert">
          {fault}
        </div>
      ) : null}
    </div>
  );
}

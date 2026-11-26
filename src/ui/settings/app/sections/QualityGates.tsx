/**
 * The gate editor of the Quality tab (T1373).
 *
 * One block per stage. Each block is a one-line-per-gate table, then the
 * "When every gate is off" row and the per-repository overrides. The gate code
 * lives here rather than in `QualitySection.tsx` so neither file crosses the
 * 800-line budget.
 *
 * The override semantics are the ones the tab always had: an override REPLACES
 * the global list, it starts as a COPY of it, and removing its LAST gate removes
 * the override itself.
 */
import { useRef } from 'react';
import type { GateDef } from '../../../../manifest/types.js';
import { emptyGate, setGateKind, validateGateDraft } from '../../gateDraft.js';
import type { DestructiveAction } from '../../messages.js';
import { useSettingsApp } from '../SettingsAppContext.js';
import { Field, type SelectOption } from '../primitives/Field.js';
import { Button } from '../primitives/Button.js';
import { IconButton } from '../primitives/IconButton.js';
import { TablerIcon } from '../primitives/TablerIcon.js';
import {
  addRepoOverride,
  parseGateBlock,
  removeRepoOverride,
  setGateEnabled,
  setProbeWhenAllDisabled,
  updateGates,
  setGateOnResourceKill,
  type Base,
} from './qualityDraft.js';

const BLOCK_TITLES: Record<Base, string> = { uat: 'UAT gates', review: 'Review gates' };

/** The global gate list plus every per-repository override for one block. */
export function GateBlock({
  base,
  repositories,
}: {
  readonly base: Base;
  readonly repositories: readonly string[];
}) {
  const { state, edit } = useSettingsApp();
  const draft = state.draft;
  const cfg = (draft as unknown as Record<Base, { gates?: GateDef[]; repositories?: object }>)[base];
  const overrides = Object.keys(cfg?.repositories ?? {});

  const gates = cfg?.gates ?? [];
  const offCount = gates.filter((g) => g.enabled === false).length;
  const allOff = gates.length > 0 && offCount === gates.length;
  const probe = (cfg as { probeWhenAllDisabled?: boolean } | undefined)?.probeWhenAllDisabled === true;
  return (
    <div
      className="gate-block"
      data-region={base === 'uat' ? 'gates' : undefined}
    >
      <div className="gate-block-head">
        <div className="gate-subhead">{BLOCK_TITLES[base]}</div>
        <span className="gate-count">
          {gates.length === 1 ? '1 gate' : `${gates.length} gates`}
          {offCount > 0 ? ` · ${offCount} off` : ''}
        </span>
        <span className="gate-note">Run in this order. Off keeps the gate in the list.</span>
      </div>
      <GateList
        block={base}
        gates={gates}
        repositories={repositories}
        emptyCopy="No gates declared — Karst probes the repository's package.json scripts instead. Not a Node project? Add a Command gate (e.g. pytest, cargo test) — it runs no npm script."
      />
      {gates.length === 0 ? null : (
        <>
          <div className="q-row">
            <Field
              label="When every gate is off"
              help="Skip: nothing runs and the stage passes. Probe: Karst runs the package.json scripts, as for an empty list."
              control={{
                kind: 'select',
                name: `${base}ProbeWhenAllDisabled`,
                value: probe ? 'probe' : 'skip',
                options: [
                  { value: 'skip', label: 'Skip the stage' },
                  { value: 'probe', label: 'Probe package.json scripts' },
                ],
                onChange: (value) =>
                  edit((current) => setProbeWhenAllDisabled(current, base, value === 'probe')),
              }}
            />
          </div>
          {allOff && !probe ? (
            <div className="callout" role="status">
              <TablerIcon name="alert-triangle" size={16} />
              <div className="callout-msg">Every gate is off — this stage will be bypassed.</div>
            </div>
          ) : null}
        </>
      )}
      {repositories.length === 0 ? null : (
        <OverrideSection base={base} repositories={repositories} overrides={overrides} />
      )}
    </div>
  );
}

/**
 * One gate list: rows keyed by the gate's own identity, never an array index
 * (R-X5), so removing a middle row cannot make React reuse the wrong DOM.
 */
function GateList({
  block,
  gates,
  repositories,
  emptyCopy,
  overrideRepo,
}: {
  readonly block: string;
  readonly gates: readonly GateDef[];
  readonly repositories: readonly string[];
  readonly emptyCopy: string;
  readonly overrideRepo?: string;
}) {
  const { edit } = useSettingsApp();
  const change = (fn: (current: readonly GateDef[]) => readonly GateDef[]): void =>
    edit((draft) => updateGates(draft, block, fn));

  const [rowIds, dropRowId] = useRowIds(block, gates.length);

  const removeAt = (index: number): void => {
    dropRowId(index);
    const next = gates.filter((_, i) => i !== index);
    // Deleting an override's LAST gate removes the OVERRIDE, not just the gate:
    // an empty override is not "this repository runs nothing", it silently means
    // "this repository runs the global list" — the opposite of what a user who
    // emptied the list asked for.
    if (overrideRepo !== undefined && next.length === 0) {
      const base = parseGateBlock(block).base;
      edit((draft) => removeRepoOverride(draft, base, overrideRepo));
      return;
    }
    change((current) => current.filter((_, i) => i !== index));
  };

  const patchAt = (index: number, patch: Partial<GateDef>): void =>
    change((current) => current.map((gate, i) => (i === index ? { ...gate, ...patch } : gate)));

  return (
    <div className={overrideRepo === undefined ? 'gate-list' : 'gate-list gate-list--override'}>
      {gates.length === 0 ? (
        <div className="gate-empty">{emptyCopy}</div>
      ) : (
        <div className="gate-head" aria-hidden="true">
          <span />
          <span>Name</span>
          <span>Kind</span>
          <span>Runs</span>
          {overrideRepo === undefined ? <span>Repository</span> : null}
          <span>On out-of-memory kill</span>
          <span />
        </div>
      )}
      {gates.map((gate, index) => {
        const n = index + 1;
        const problem = validateGateDraft(gate);
        const nameInvalid = !gate.name || gate.name.trim().length === 0;
        const runInvalid =
          !nameInvalid &&
          (gate.kind === 'script'
            ? !gate.script || gate.script.trim().length === 0
            : !gate.command || gate.command.trim().length === 0);
        return (
          <div className="gate-item" key={rowIds[index]}>
            <div className={gate.enabled === false ? 'gate-row gate-off' : 'gate-row'}>
              <div className="gate-on">
                <Field
                  label={`Gate ${n} enabled`}
                  hideLabel
                  control={{
                    kind: 'checkbox',
                    name: undefined,
                    checked: gate.enabled !== false,
                    onChange: (checked) =>
                      change((current) =>
                        current.map((g, i) => (i === index ? setGateEnabled(g, checked) : g)),
                      ),
                  }}
                />
              </div>
              <GateTextField
                label={`Gate ${n} name`}
                value={gate.name ?? ''}
                placeholder="name"
                className="gate-name"
                invalid={nameInvalid}
                onChange={(value) => patchAt(index, { name: value })}
              />
              <GateSelect
                label={`Gate ${n} kind`}
                value={gate.kind}
                className="gate-kind"
                options={[
                  { value: 'script', label: 'script' },
                  { value: 'command', label: 'command' },
                ]}
                onChange={(value) =>
                  change((current) =>
                    current.map((g, i) => (i === index ? setGateKind(g, value as GateDef['kind']) : g)),
                  )
                }
              />
              <div className="gate-runs">
                {gate.kind === 'script' ? (
                  <div className="gate-runs-script">
                    <span className="gate-prefix" aria-hidden="true">
                      npm run
                    </span>
                    <GateTextField
                      label={`Gate ${n} script`}
                      value={gate.script ?? ''}
                      placeholder="npm script, e.g. test"
                      invalid={runInvalid}
                      onChange={(value) => patchAt(index, { script: value })}
                    />
                  </div>
                ) : (
                  <div className="gate-runs-command">
                    <GateTextField
                      label={`Gate ${n} command`}
                      value={gate.command ?? ''}
                      placeholder="command, e.g. pytest"
                      className="gate-command"
                      invalid={runInvalid}
                      onChange={(value) => patchAt(index, { command: value })}
                    />
                    <GateTextField
                      label={`Gate ${n} arguments`}
                      value={(gate.args ?? []).join(' ')}
                      placeholder="arguments, space-separated"
                      onChange={(value) =>
                        patchAt(index, {
                          args: value.trim() === '' ? [] : value.trim().split(/\s+/),
                        })
                      }
                    />
                  </div>
                )}
              </div>
              {overrideRepo === undefined ? (
                <div className="gate-repo" data-label="Repository">
                  <GateSelect
                    label={`Gate ${n} repository`}
                    value={gate.repo ?? ''}
                    options={[
                      { value: '', label: 'All repositories' },
                      ...repositories.map((repo) => ({ value: repo, label: repo })),
                    ]}
                    onChange={(value) => patchAt(index, { repo: value || undefined })}
                  />
                </div>
              ) : null}
              <div className="gate-oom" data-label="OOM kill">
                <GateSelect
                  label={`Gate ${n} on out-of-memory kill`}
                  value={gate.onResourceKill ?? 'retry-then-park'}
                  disabled={gate.enabled === false}
                  options={[
                    { value: 'retry-then-park', label: 'Retry then ask' },
                    { value: 'park', label: 'Ask' },
                    { value: 'host', label: 'Run on host' },
                  ]}
                  onChange={(value) =>
                    change((current) =>
                      current.map((g, i) =>
                        i === index ? setGateOnResourceKill(g, value as NonNullable<GateDef['onResourceKill']>) : g,
                      ),
                    )
                  }
                />
              </div>
              <div className="gate-remove">
                <IconButton
                  danger
                  label={`Remove gate ${n}`}
                  data-karst-action={'remove-gate' satisfies DestructiveAction}
                  onClick={() => removeAt(index)}
                >
                  <TablerIcon name="trash" />
                </IconButton>
              </div>
            </div>
            {problem ? (
              <div className="gate-problem" role="alert">
                {problem}
              </div>
            ) : null}
          </div>
        );
      })}
      <div className="gate-actions">
        <Button variant="text" className="gate-add" onClick={() => change((current) => [...current, emptyGate()])}>
          + Add gate
        </Button>
      </div>
    </div>
  );
}

/**
 * Row keys that survive editing (R-X5). A key derived from the gate's name
 * remounted the row on every keystroke in that name — the input lost focus
 * after one character. These ids are minted once per row, follow a removal,
 * and only reset when the list is shortened from outside (Discard, host push).
 */
function useRowIds(block: string, length: number): readonly [readonly string[], (at: number) => void] {
  const counter = useRef(0);
  const ids = useRef<readonly string[]>([]);
  if (ids.current.length > length) ids.current = ids.current.slice(0, length);
  while (ids.current.length < length) {
    counter.current += 1;
    ids.current = [...ids.current, `${block}:row-${counter.current}`];
  }
  const drop = (at: number): void => {
    ids.current = ids.current.filter((_, i) => i !== at);
  };
  return [ids.current, drop];
}

function GateTextField({
  label,
  value,
  placeholder,
  onChange,
  invalid = false,
  className,
}: {
  readonly label: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly onChange: (value: string) => void;
  readonly invalid?: boolean;
  readonly className?: string;
}) {
  return (
    <Field
      label={label}
      hideLabel
      className={className}
      control={{
        kind: 'input',
        name: undefined,
        value,
        placeholder,
        controlClassName: invalid ? 'gate-invalid' : undefined,
        onChange,
      }}
    />
  );
}

function GateSelect({
  label,
  value,
  options,
  onChange,
  hideLabel = true,
  disabled = false,
  className,
}: {
  readonly hideLabel?: boolean;
  readonly disabled?: boolean;
  readonly label: string;
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly onChange: (value: string) => void;
  readonly className?: string;
}) {
  return (
    <Field
      label={label}
      hideLabel={hideLabel}
      className={className}
      control={{ kind: 'select', name: undefined, value, options, onChange, disabled }}
    />
  );
}

/** The override tables plus the picker row that adds one. */
function OverrideSection({
  base,
  repositories,
  overrides,
}: {
  readonly base: Base;
  readonly repositories: readonly string[];
  readonly overrides: readonly string[];
}) {
  const { state, edit } = useSettingsApp();
  const draft = state.draft;
  const cfg = (draft as unknown as Record<Base, {
    gates?: GateDef[];
    repositories?: Record<string, { gates?: GateDef[] }>;
  }>)[base] ?? {};
  const available = repositories.filter((repo) => !overrides.includes(repo));

  return (
    <div className="override-editor">
      <div className="q-row">
        <Field
          label="Repository to override"
          help="An override replaces the global list for one repository. It starts as a copy of the list."
          control={{
            kind: 'select',
            name: undefined,
            value: '',
            disabled: available.length === 0,
            options:
              available.length === 0
                ? [{ value: '', label: 'No other repository', disabled: true }]
                : [
                    { value: '', label: 'Add override for…', disabled: true },
                    ...available.map((repo) => ({ value: repo, label: repo })),
                  ],
            onChange: (repo) =>
              edit((current) => addRepoOverride(current, base, repo, cfg.gates ?? [])),
          }}
        />
      </div>
      {overrides.map((repo) => {
        const gates = cfg.repositories?.[repo]?.gates ?? [];
        return (
          <div className="override-card" key={`${base}:${repo}`}>
            <div className="override-card-head">
              <span className="override-repo">{repo}</span>
              <span className="override-meta">replaces the global list</span>
              <span className="override-count">
                {gates.length === 1 ? '1 gate' : `${gates.length} gates`}
              </span>
              <IconButton
                danger
                label={`Remove ${repo} override`}
                data-karst-action={'remove-override' satisfies DestructiveAction}
                onClick={() => edit((current) => removeRepoOverride(current, base, repo))}
              >
                <TablerIcon name="trash" />
              </IconButton>
            </div>
            <GateList
              block={`${base}:${repo}`}
              gates={gates}
              repositories={repositories}
              overrideRepo={repo}
              emptyCopy="No gates here — this repository runs the global list."
            />
          </div>
        );
      })}
    </div>
  );
}

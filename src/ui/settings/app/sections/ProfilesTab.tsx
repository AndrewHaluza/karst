/**
 * The Agent profiles tab: a searchable list (Local · From approach · Built-in
 * prompts) and, for the selected item, its real text.
 *
 *  - **Local** — editable here (⌘/Ctrl+S, Revert / Save); Save writes
 *    `.karst/agents/<name>.md` through the host's save-agent-file action.
 *  - **From approach** — read-only: the text is the approach's; "manage in
 *    approach" opens that tab.
 *  - **Built-in** — the real prompt behind the role, read-only; "Customize…"
 *    creates a local profile from it and assigns it to the role. A fixed-prompt
 *    role has no profile prompt: a profile changes its identity only.
 *
 * Text being edited is a LOCAL BUFFER owned by the Agents page (so switching
 * tabs or items never loses it); this component only reads and writes it.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useSettingsApp } from '../SettingsAppContext.js';
import { useHostMutation } from '../useHostMutation.js';
import { Button } from '../primitives/Button.js';
import { Chip } from '../primitives/Chip.js';
import { Field } from '../primitives/Field.js';
import { Switch } from '../primitives/Switch.js';
import { PROCESS_ROLE_BY_KEY, type ProcessKey } from '../../../../manifest/validate/processAssignments.js';
import type { AgentsRoute } from './agentsRoute.js';
import {
  buildProfileEntries, builtInId, customProfileName, filterEntries, groupEntries, type ProfileEntry,
} from './profileModel.js';
import { setRoleProfile } from './rolesModel.js';

export interface ProfilesTabProps {
  readonly route: AgentsRoute;
  readonly navigate: (route: AgentsRoute) => void;
  /** Edited text by profile name; absent = untouched. */
  readonly buffers: Readonly<Record<string, string>>;
  readonly setBuffer: (name: string, text: string | null) => void;
}

const isDirty = (entry: ProfileEntry, buffers: Readonly<Record<string, string>>): boolean =>
  entry.editable && buffers[entry.id] !== undefined && buffers[entry.id] !== (entry.text ?? '');

export function ProfilesTab({ route, navigate, buffers, setBuffer }: ProfilesTabProps) {
  const { state, edit, send, setSection } = useSettingsApp();
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  const labels = useMemo(
    () => Object.fromEntries((state.processAssignments ?? []).map((v) => [v.key, v.roleLabel])),
    [state.processAssignments],
  );
  const capabilities = useMemo(() => (state.processAssignments ?? []).map((v) => v.key as string), [state.processAssignments]);
  const entries = useMemo(
    () => buildProfileEntries(state.host?.agents ?? [], state.draft, labels, state.host?.builtInPrompts ?? {}, capabilities),
    [state.host?.agents, state.host?.builtInPrompts, state.draft, labels, capabilities],
  );
  const visible = filterEntries(entries, query);
  const selected = entries.find((e) => e.id === route.selected) ?? null;
  const roleLabel = (cap: string): string => labels[cap as ProcessKey] ?? cap;

  const save = useHostMutation<[string, string]>({
    kind: 'Save agent profile',
    send: (requestId, name, body) => send.saveAgentFile(name, body, requestId),
  });
  const create = useHostMutation<[string]>({
    kind: 'Create agent profile',
    send: (requestId, name) => send.createAgent(name, requestId),
  });
  const toggle = useHostMutation<[string, boolean]>({
    kind: 'Enable in create flow',
    send: (requestId, name, enabled) => send.setAgentEnabled(name, enabled, requestId),
  });

  // Settle each request once from the host's receipt; a saved buffer is cleared
  // only on success so a refused write never loses the text.
  const settled = useRef<ReadonlySet<string>>(new Set());
  const saving = useRef<string | null>(null);
  useEffect(() => {
    for (const mutation of [save, create, toggle]) {
      const id = mutation.requestId;
      const receipt = id === undefined ? undefined : state.receipts[id];
      if (id === undefined || receipt === undefined || settled.current.has(id)) continue;
      settled.current = new Set(settled.current).add(id);
      if (receipt.ok) {
        mutation.settle({ requestId: id, result: 'success' });
        setError(null);
        if (mutation === save && saving.current !== null) setBuffer(saving.current, null);
      } else {
        mutation.settle({ requestId: id, result: 'failure', message: receipt.message ?? undefined });
        setError(receipt.message ?? 'The host refused the change.');
      }
    }
  }, [state.receipts, save, create, toggle, setBuffer]);

  const commit = (entry: ProfileEntry): void => {
    const text = buffers[entry.id];
    if (text === undefined || !isDirty(entry, buffers)) return;
    saving.current = entry.id;
    save.trigger(entry.id, text);
  };

  const customize = (entry: ProfileEntry): void => {
    if (entry.capability === undefined || entry.text === null) return;
    const base = PROCESS_ROLE_BY_KEY[entry.capability as ProcessKey] ?? entry.capability;
    const name = customProfileName(base, new Set((state.host?.agents ?? []).map((a) => a.name)));
    create.trigger(name);
    send.saveAgentFile(name, entry.text);
    edit((d) => setRoleProfile(d, entry.capability as string, name));
    navigate({ tab: 'profiles', selected: name });
  };

  // ⌘/Ctrl+S saves the buffer being edited instead of the page.
  const onKeyDown = (event: KeyboardEvent): void => {
    if ((event.metaKey || event.ctrlKey) && (event.key === 's' || event.key === 'S') && selected?.editable) {
      event.preventDefault();
      event.stopPropagation();
      commit(selected);
    }
  };

  return (
    <div className={`agents-profiles${selected ? ' has-selection' : ''}`} onKeyDown={onKeyDown}>
      <div className="agents-list" data-region="list">
        <Field
          label="Search profiles"
          hideLabel
          control={{ kind: 'input', type: 'search', name: 'agents-profile-search', value: query, placeholder: 'Search profiles', onChange: setQuery }}
        />
        {entries.length === 0 ? <div className="agents-empty">No agent profiles yet.</div> : null}
        {groupEntries(visible).map((group) => (
          <div key={group.key} className="agents-group">
            <div className="agents-group-title">{group.title}</div>
            {group.entries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`agents-item${entry.id === selected?.id ? ' is-selected' : ''}`}
                aria-current={entry.id === selected?.id ? 'true' : undefined}
                onClick={() => navigate({ tab: 'profiles', selected: entry.id })}
              >
                <span className="agents-item-name">{entry.name}</span>
                {isDirty(entry, buffers) ? <span className="agents-dirty-dot" role="img" aria-label="unsaved changes" /> : null}
                <span className="agents-muted">{entry.usedBy.length > 0 ? `used by ${entry.usedBy.length}` : 'unused'}</span>
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="agents-detail" data-region="detail">
        {selected === null ? (
          <div className="agents-empty">Select a profile to read its text.</div>
        ) : (
          <>
            <Button variant="text" size="sm" className="agents-back" onClick={() => navigate({ tab: 'profiles' })}>
              ← Back
            </Button>
            <div className="agents-detail-head">
              <span className="agents-detail-name">{selected.name}</span>
              <Chip>
                {selected.group === 'local'
                  ? 'Local'
                  : selected.group === 'approach'
                    ? `From approach: ${selected.approachId ?? ''}`
                    : 'Built-in prompt'}
              </Chip>
            </div>

            {selected.group !== 'builtin' ? (
              <Switch
                name={`agent-enabled-${selected.id}`}
                checked={selected.enabled === true}
                label="Enable in create flow"
                onChange={(on) => toggle.trigger(selected.id, on)}
              />
            ) : null}

            <div className="agents-used-by">
              <span className="agents-muted">Used by:</span>
              {selected.usedBy.length === 0 ? <span className="agents-muted">unused</span> : null}
              {selected.usedBy.map((cap) => (
                <Button
                  key={cap}
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate({ tab: 'roles', selected: cap })}
                >
                  {roleLabel(cap)}
                </Button>
              ))}
            </div>

            {selected.group !== 'builtin' ? (
              <Field
                label="Assign to…"
                control={{
                  kind: 'select',
                  name: 'agents-assign',
                  value: '',
                  options: [{ value: '', label: 'Choose a role…' }, ...capabilities.map((c) => ({ value: c, label: roleLabel(c) }))],
                  onChange: (cap) => cap !== '' && edit((d) => setRoleProfile(d, cap, selected.id)),
                }}
              />
            ) : null}

            <ProfileText
              entry={selected}
              buffer={buffers[selected.id]}
              onBuffer={(text) => setBuffer(selected.id, text)}
              onSave={() => commit(selected)}
              onRevert={() => setBuffer(selected.id, null)}
              onCustomize={() => customize(selected)}
              onManage={() => setSection('approaches')}
              saving={save.busy}
              dirty={isDirty(selected, buffers)}
            />
            {error !== null ? (
              <div className="agents-fault" role="alert">
                {error}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

interface ProfileTextProps {
  readonly entry: ProfileEntry;
  readonly buffer: string | undefined;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly onBuffer: (text: string) => void;
  readonly onSave: () => void;
  readonly onRevert: () => void;
  readonly onCustomize: () => void;
  readonly onManage: () => void;
}

function ProfileText({ entry, buffer, dirty, saving, onBuffer, onSave, onRevert, onCustomize, onManage }: ProfileTextProps) {
  if (entry.group === 'local') {
    return (
      <div className="agents-text">
        <Field
          label={`${entry.name} text`}
          hideLabel
          control={{ kind: 'textarea', name: `agent-body-${entry.id}`, rows: 14, value: buffer ?? entry.text ?? '', onChange: onBuffer }}
        />
        <div className="agents-text-foot" data-region="toolbar">
          <span className="agents-muted">Editing .karst/agents/{entry.name}.md</span>
          <Button variant="ghost" size="sm" disabled={!dirty} onClick={onRevert}>
            Revert
          </Button>
          <Button variant="primary" size="sm" busy={saving} disabled={!dirty} onClick={onSave}>
            Save
          </Button>
        </div>
      </div>
    );
  }
  if (entry.group === 'approach') {
    return (
      <div className="agents-text">
        <pre className="agents-readonly" aria-label={`${entry.name} text`}>{entry.text ?? 'The text could not be read.'}</pre>
        <div className="agents-text-foot" data-region="toolbar">
          <span className="agents-muted">Provided by approach {entry.approachId} — manage in approach</span>
          <Button variant="text" size="sm" onClick={onManage}>
            manage in approach ↗
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="agents-text">
      {entry.promptBearing ? (
        <pre className="agents-readonly" aria-label={`${entry.name} built-in prompt`}>{entry.text ?? ''}</pre>
      ) : (
        <div className="agents-note">
          This process keeps its built-in prompt; an agent profile changes identity only.
        </div>
      )}
      <div className="agents-text-foot" data-region="toolbar">
        <span className="agents-muted">built-in prompt</span>
        <Button variant="secondary" size="sm" disabled={!entry.promptBearing} onClick={onCustomize}>
          Customize…
        </Button>
      </div>
    </div>
  );
}

export { builtInId };

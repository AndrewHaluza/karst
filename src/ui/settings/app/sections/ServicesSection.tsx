/**
 * The Services tab (NDL-126 §8.3, phase 3 step 3) — the repository/port/binding
 * graph.
 *
 * Ported one-to-one from the vanilla `renderServices()` family. The behaviours
 * that are easy to lose, and where each one lives (`serviceDraft.ts` holds the
 * pure rules, `ServiceFields.tsx` the per-service editor):
 *
 * - **`repositories` is SPREAD, never rebuilt.** The host's `mergeSection`
 *   deletes a field the incoming manifest no longer carries, so a rebuilt map
 *   drops every repository this tab does not render (D1/D3, the same rule as Git's
 *   `conventions` and Agents' `processes`).
 * - **A DRAFT repository is a DISABLED one.** Add creates no `service` key and
 *   `enabled: false`; the system never uses a disabled repository, so an
 *   incomplete one is a valid manifest.
 * - **A rename is a RE-KEY**, repointing every `dependsOn.target` that named the
 *   old name — otherwise a dependency points at a repository that no longer
 *   exists.
 * - **Two shapes, kept as written.** A repository is either the `service:`
 *   shorthand (ONE service, edited exactly as before) or the `services:` map (each
 *   entry its own block, with a name and a `cwd`). The shorthand offers an explicit
 *   "Split into several services"; the map never collapses back on its own.
 * - **Runtime fields render only when there IS a service.** An empty "Start
 *   command" box is what used to invite a fake value.
 * - **An empty port list is NOT "nothing happens".** The host falls back to
 *   probing `package.json`, so the empty state says which fallback applies.
 * - **The folder picker is the REDUCER's job.** `repo-path-picked` applies the
 *   path AND marks the field touched, so this component never re-applies it.
 *
 * Faults: `parseRepoFieldError` maps a repository fault to `<name>.<field>`, and
 * a mapped fault stays SILENT until the user has touched that exact field — so a
 * freshly added repository shows no error before anyone has typed anything.
 *
 * **Gates and gate overrides are NOT here.** They live on the Quality tab.
 */
import { useMemo, useState } from 'react';
import type { Manifest, RepositoryDef, ServiceDef } from '../../../../manifest/types.js';
import { useSettingsApp } from '../SettingsAppContext.js';
import { manifestFaultDetail, parseRepoFieldError, shouldShowBanner } from '../diagnostics.js';
import { Field } from '../primitives/Field.js';
import { Button } from '../primitives/Button.js';
import { Switch } from '../primitives/Switch.js';
import { Chip } from '../primitives/Chip.js';
import { DestructiveButton } from '../primitives/DestructiveButton.js';
import { ServiceFields } from './ServiceFields.js';
import {
  addService,
  addSignal,
  baselineFor,
  dependencyTargetsFor,
  isMultiService,
  isRunnable,
  newRepository,
  nextRepositoryName,
  nextServiceName,
  portsOfTarget,
  removeService,
  removeSignal,
  renameRepository,
  renameServiceInDraft,
  repositoryNames,
  runtimeBadge,
  splitToServices,
  writeRepository,
  writeRepositoryField,
  writeService,
} from './serviceDraft.js';

export function ServicesSection() {
  const { state, edit, send, touch } = useSettingsApp();
  const draft = state.draft;
  const names = useMemo(() => repositoryNames(draft), [draft]);
  const fieldError = useRepositoryFieldErrors();
  // Which cards are expanded is component state, not a manifest field: it is a
  // view concern and must never reach Save.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());

  const toggle = (name: string): void =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(name)) next.add(name);
      return next;
    });

  const add = (): void => {
    const name = nextRepositoryName(draft);
    edit((current) => writeRepository(current, name, { ...newRepository(), name } as RepositoryDef));
    // The new card opens itself — the user just created it.
    setOpen((prev) => new Set(prev).add(name));
  };

  if (names.length === 0) {
    return (
      <div className="section" id="section-services">
        <div className="page-header">
          <div className="page-title">Repositories</div>
          <div className="page-desc">
            Compact at rest; runtime, ports, dependencies, bindings, migrations and signals appear
            when a repository is opened.
          </div>
          <div className="page-actions">
            <Button variant="secondary" onClick={add}>
              + Add repository
            </Button>
          </div>
        </div>
        <div className="k-empty">
          <div className="k-empty-title">No repositories configured.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="section" id="section-services">
      <div className="page-header">
        <div className="page-title">Repositories</div>
        <div className="page-desc">
          Compact at rest; runtime, ports, dependencies, bindings, migrations and signals appear
          when a repository is opened.
        </div>
        <div className="page-actions">
          <Button variant="secondary" onClick={add}>
            + Add repository
          </Button>
        </div>
      </div>

      <div className="roster">
        <div className="roster-head repo-cols">
          <div>Repository</div>
          <div>Path</div>
          <div>Baseline</div>
          <div>Runtime</div>
          <div />
        </div>
        {names.map((name) => (
          <RepositoryCard
            key={name}
            name={name}
            repo={(draft.repositories ?? {})[name] as RepositoryDef}
            draft={draft}
            isOpen={open.has(name)}
            projectBaseline={draft.baselineBranch}
            onToggle={() => toggle(name)}
            onWrite={(patch) => edit((current) => writeRepositoryField(current, name, patch))}
            onReplace={(next) => edit((current) => writeRepository(current, name, next))}
            onRename={(raw) => {
              const renamed = renameRepository(draft, name, raw);
              // A blank or duplicate name is refused; the re-render restores the
              // old value, exactly as the vanilla view does.
              if (renamed) edit(() => renamed);
            }}
            onRenameService={(service, raw) => {
              const renamed = renameServiceInDraft(draft, name, service, raw);
              if (renamed) edit(() => renamed);
            }}
            onRemove={() => edit((current) => writeRepository(current, name, null))}
            onTouch={touch}
            onBrowsePath={() => send.browseRepoPath(name)}
            fieldError={fieldError}
          />
        ))}
      </div>
    </div>
  );
}

/** One repository row: the roster head is the row opener, the editor sits below. */
function RepositoryCard({
  name,
  repo,
  draft,
  isOpen,
  projectBaseline,
  onToggle,
  onWrite,
  onReplace,
  onRename,
  onRenameService,
  onRemove,
  onTouch,
  onBrowsePath,
  fieldError,
}: {
  readonly name: string;
  readonly repo: RepositoryDef;
  readonly draft: Manifest;
  readonly isOpen: boolean;
  readonly projectBaseline: string | undefined;
  readonly onToggle: () => void;
  readonly onWrite: (patch: Partial<RepositoryDef>) => void;
  readonly onReplace: (next: RepositoryDef) => void;
  readonly onRename: (raw: string) => void;
  readonly onRenameService: (service: string, raw: string) => void;
  readonly onRemove: () => void;
  /** Takes the full `<repo>.<field>` (or `<repo>/<service>.<field>`) key. */
  readonly onTouch: (key: string) => void;
  readonly onBrowsePath: () => void;
  readonly fieldError: (key: string) => string | undefined;
}) {
  const runnable = isRunnable(repo);
  const enabled = repo.enabled !== false;
  const targetsFor = (ownerKey: string): readonly string[] => dependencyTargetsFor(draft, ownerKey);
  const targetPorts = (target: string): readonly string[] => portsOfTarget(draft, target);

  return (
    <div className={`card ${isOpen ? 'open is-selected' : ''}`} data-card={name}>
      <div className="card-head roster-row repo-cols">
        {/*
          The disclosure is a real `<button aria-expanded>`, not the whole row — the
          accordion is keyboard-usable (UI-R09). The enable switch and Remove are
          SIBLINGS of the toggle, never descendants.
        */}
        <button
          type="button"
          className="card-toggle"
          data-toggle={name}
          aria-expanded={isOpen}
          aria-controls={`card-body-${name}`}
          onClick={onToggle}
        >
          <span className="chevron" aria-hidden="true">
            ▸
          </span>
          <span className="card-title">{name}</span>
        </button>
        <span className="cell-path" title={repo.repoPath || ''}>
          {repo.repoPath || '—'}
        </span>
        <span className="cell-meta mono">{baselineFor(repo, projectBaseline)}</span>
        <span className="cell-meta">
          <Chip tone={runnable ? 'success' : 'neutral'} name={`runtime-${name}`}>
            {runtimeBadge(repo) === 'worktree' ? 'worktree only' : runtimeBadge(repo)}
          </Chip>
        </span>
        <span className="cell-actions">
          {enabled ? null : <Chip name={`draft-${name}`}>Draft</Chip>}
          {runnable ? null : <span className="field-hint">no service</span>}
          <Switch
            name={`repo-enabled-${name}`}
            checked={enabled}
            label={enabled ? 'Disable this repository' : 'Enable this repository'}
            onChange={(next) => onWrite({ enabled: next })}
          />
          <DestructiveButton action="remove-service" size="sm" onClick={onRemove}>
            Remove
          </DestructiveButton>
        </span>
      </div>

      <div className="card-body" id={`card-body-${name}`} hidden={!isOpen}>
        <Field
          label="Name"
          help="The repository's manifest key. Renaming re-points every dependency that names it."
          control={{
            kind: 'input',
            name: `f-svc-name-${name}`,
            value: name,
            placeholder: 'my-repo',
            onChange: onRename,
          }}
        />
        <Field
          label="Repo path"
          // A mapped fault stays silent until the field is touched — that is what
          // stops a freshly added repository showing an error before anyone has
          // typed anything.
          error={fieldError(`${name}.repoPath`)}
          control={{
            kind: 'input',
            name: `f-svc-repoPath-${name}`,
            value: repo.repoPath,
            placeholder: `/Users/you/code/${name}`,
            onChange: (value) => {
              onTouch(`${name}.repoPath`);
              onWrite({ repoPath: value });
            },
          }}
        />
        <Button variant="secondary" size="sm" onClick={onBrowsePath}>
          Browse…
        </Button>
        <Field
          label={`Baseline branch override (blank inherits ${projectBaseline ?? 'main'})`}
          control={{
            kind: 'input',
            name: `f-svc-baseline-${name}`,
            value: repo.baselineBranch ?? '',
            placeholder: 'main',
            onChange: (value) => onWrite({ baselineBranch: value === '' ? undefined : value }),
          }}
        />
        <Field
          label="Has migrations"
          help="Author-declared: does this repository carry DB migrations?"
          control={{
            kind: 'checkbox',
            name: `f-svc-migrations-${name}`,
            checked: repo.hasMigrations === true,
            onChange: (checked) => onWrite({ hasMigrations: checked }),
          }}
        />
        <Field
          label="Runnable service"
          help="Off means karst gives this repo a worktree but never starts it. No port, no health check."
          control={{
            kind: 'checkbox',
            name: `f-svc-runnable-${name}`,
            checked: runnable,
            onChange: (checked) =>
              onWrite(
                checked
                  ? ({ service: { start: '', ports: [], dependsOn: [] } } as unknown as Partial<RepositoryDef>)
                  : { service: undefined, services: undefined },
              ),
          }}
        />

        {isMultiService(repo) ? (
          <ServiceEntries
            name={name}
            repo={repo}
            targetsFor={targetsFor}
            targetPorts={targetPorts}
            fieldError={fieldError}
            onTouch={onTouch}
            onReplace={onReplace}
            onRenameService={onRenameService}
          />
        ) : runnable && repo.service ? (
          <>
            <ServiceFields
              scope={name}
              keyPrefix={name}
              def={repo.service}
              others={targetsFor(name)}
              targetPorts={targetPorts}
              fieldError={fieldError}
              onTouch={onTouch}
              onDef={(next) => onWrite({ service: next })}
            />
            {/* The explicit, one-way conversion to the named map (never automatic). */}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onReplace(splitToServices(repo, name))}
            >
              Split into several services
            </Button>
          </>
        ) : null}

        <h2>Signals</h2>
        <div className="chips" data-signals={name}>
          {(repo.signals ?? []).map((signal) => (
            <Chip key={`${name}-signal-${signal}`} name={`signal-${signal}`}>
              {signal}
              <DestructiveButton
                action="remove-signal"
                size="sm"
                aria-label={`Remove signal ${signal}`}
                title={`Remove signal ${signal}`}
                onClick={() => onReplace(removeSignal(repo, signal))}
              >
                &times;
              </DestructiveButton>
            </Chip>
          ))}
        </div>
        <SignalInput name={name} onAdd={(signal) => onReplace(addSignal(repo, signal))} />
      </div>
    </div>
  );
}

/**
 * The `services:` map: one block per service, each with its own name and `cwd`
 * (UI-R10b: removing a service is irreversible, so it takes the danger treatment).
 * Names are validated by `renameServiceInDraft`, which refuses an illegal or
 * duplicate name and leaves the draft alone.
 */
function ServiceEntries({
  name,
  repo,
  targetsFor,
  targetPorts,
  fieldError,
  onTouch,
  onReplace,
  onRenameService,
}: {
  readonly name: string;
  readonly repo: RepositoryDef;
  readonly targetsFor: (ownerKey: string) => readonly string[];
  readonly targetPorts: (target: string) => readonly string[];
  readonly fieldError: (key: string) => string | undefined;
  readonly onTouch: (key: string) => void;
  readonly onReplace: (next: RepositoryDef) => void;
  readonly onRenameService: (service: string, raw: string) => void;
}) {
  return (
    <>
      {Object.entries(repo.services ?? {}).map(([svc, def]: [string, ServiceDef]) => {
        const scope = `${name}-${svc}`;
        // A map entry's fault namespace is `repo/service`, which no parsed fault
        // names, so its errors stay unmapped rather than landing on the repo's fields.
        const keyPrefix = `${name}/${svc}`;
        return (
          <div key={svc} className="card" data-service-card={svc}>
            <div className="card-body">
              <Field
                label="Service name"
                help="Unique within this repository. Letters, digits, dot, underscore and dash."
                control={{
                  kind: 'input',
                  name: `f-svc-entry-name-${scope}`,
                  value: svc,
                  placeholder: 'web',
                  onChange: (raw) => onRenameService(svc, raw),
                }}
              />
              <Field
                label="Working directory (blank runs from the repository root)"
                help="Relative to the repository root, e.g. apps/web. No .. and no leading slash."
                control={{
                  kind: 'input',
                  name: `f-svc-cwd-${scope}`,
                  value: def.cwd ?? '',
                  placeholder: 'apps/web',
                  onChange: (value) =>
                    onReplace(writeService(repo, svc, { cwd: value === '' ? undefined : value })),
                }}
              />
              <ServiceFields
                scope={scope}
                keyPrefix={keyPrefix}
                def={def}
                others={targetsFor(keyPrefix)}
                targetPorts={targetPorts}
                fieldError={fieldError}
                onTouch={onTouch}
                onDef={(next) => onReplace(writeService(repo, svc, next))}
              />
              <DestructiveButton
                action="remove-service"
                size="sm"
                aria-label={`Remove service ${svc}`}
                title={`Remove service ${svc}`}
                onClick={() => onReplace(removeService(repo, svc))}
              >
                Remove service
              </DestructiveButton>
            </div>
          </div>
        );
      })}
      <Button
        variant="secondary"
        size="sm"
        onClick={() => onReplace(addService(repo, nextServiceName(repo)))}
      >
        + Add service
      </Button>
    </>
  );
}

/** The signal composer: one word, added on Enter. */
function SignalInput({ name, onAdd }: { readonly name: string; readonly onAdd: (signal: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <div className="row">
      <Field
        label={<span className="sr-only">{`Add signal word for ${name}`}</span>}
        control={{
          kind: 'input',
          name: `f-signal-${name}`,
          value,
          placeholder: 'add signal word, Enter to add',
          onChange: setValue,
        }}
      />
      <Button
        variant="secondary"
        size="sm"
        disabled={value.trim() === ''}
        onClick={() => {
          onAdd(value);
          setValue('');
        }}
      >
        Add
      </Button>
    </div>
  );
}

/**
 * The inline faults of the CURRENT tab, keyed `<repo>.<field>`.
 *
 * A repository fault maps to exactly one field (`parseRepoFieldError`), and it
 * stays SILENT until the user has touched that exact field — that is what stops
 * a freshly added repository from showing an error before anyone has typed
 * anything. The banner follows the same rule via `shouldShowBanner`, so the two
 * can never disagree about whether a fault is visible.
 */
function useRepositoryFieldErrors(): (key: string) => string | undefined {
  const { state } = useSettingsApp();
  return useMemo(() => {
    // The draft's own verdict first, the host-reported failure second — the same
    // precedence the shell's banner uses.
    const fault = state.validation.ok ? state.hostError : state.validation.error;
    if (!fault) return () => undefined;
    const mapped = parseRepoFieldError(fault);
    if (!mapped) return () => undefined;
    if (!shouldShowBanner(fault, state.touched)) return () => undefined;
    return (key: string) => (mapped.key === key ? manifestFaultDetail(fault) : undefined);
  }, [state.validation.ok, state.validation.error, state.hostError, state.touched]);
}

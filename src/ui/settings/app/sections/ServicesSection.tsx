/**
 * The Services tab (NDL-126 §8.3, phase 3 step 3) — the repository/port/binding
 * graph.
 *
 * Ported one-to-one from the vanilla `renderServices()` family. The behaviours
 * that are easy to lose, and where each one lives (`serviceDraft.ts` holds the
 * pure rules):
 *
 * - **`repositories` is SPREAD, never rebuilt.** The host's `mergeSection`
 *   deletes a field the incoming manifest no longer carries, so a rebuilt map
 *   drops every repository this tab does not render — silently deleting
 *   configuration (D1/D3, the same rule as Git's `conventions` and Agents'
 *   `processes`).
 * - **A DRAFT repository is a DISABLED one.** Add creates no `service` key and
 *   `enabled: false`; the system never uses a disabled repository, so an
 *   incomplete one is a valid manifest. The old default built an empty
 *   start/ports shape, which is what made a placeholder command the path of least
 *   resistance.
 * - **A rename is a RE-KEY**, repointing every `dependsOn.target` that named the
 *   old name — otherwise a dependency points at a repository that no longer
 *   exists.
 * - **Runtime fields render only when there IS a service.** An empty "Start
 *   command" box is what used to invite a fake value.
 * - **An empty port list is NOT "nothing happens".** The host falls back to
 *   probing `package.json`, so the empty state says which fallback applies. The
 *   same applies to an empty override, which is indistinguishable from no
 *   override.
 * - **The folder picker is the REDUCER's job.** `repo-path-picked` applies the
 *   path AND marks the field touched, so this component never re-applies it — a
 *   component that re-applied it would mark a field the user never focused.
 *
 * Faults: `parseRepoFieldError` maps a repository fault to `<name>.<field>`, and
 * a mapped fault stays SILENT until the user has touched that exact field — so a
 * freshly added repository shows no error before anyone has typed anything.
 *
 * **Gates and gate overrides are NOT here.** They live on the Quality tab and
 * were ported in phase 3 step 2 (`QualitySection.tsx`), which owns
 * `remove-gate` and `remove-override`. This tab owns the other five members.
 *
 * Async lifecycle: there is none here — every control is a draft edit, and the
 * host's Save/validate lifecycle belongs to the shell. No `useHostMutation` call
 * is needed and none is invented.
 */
import { useMemo, useState } from 'react';
import type {
  DependsOn,
  Manifest,
  PortSlot,
  RepositoryDef,
  ServiceDef,
} from '../../../../manifest/types.js';
import { useSettingsApp } from '../SettingsAppContext.js';
import {
  manifestFaultDetail,
  parseRepoFieldError,
  shouldShowBanner,
} from '../diagnostics.js';
import { Field } from '../primitives/Field.js';
import { Button } from '../primitives/Button.js';
import { IconButton } from '../primitives/IconButton.js';
import { Switch } from '../primitives/Switch.js';
import { Chip } from '../primitives/Chip.js';
import { DestructiveButton } from '../primitives/DestructiveButton.js';
import {
  addPort,
  addSignal,
  baselineFor,
  dependencyTargets,
  emptyPortsNotice,
  isRunnable,
  newRepository,
  nextRepositoryName,
  parseLines,
  portDefault,
  portsOf,
  removePort,
  removeSignal,
  renameRepository,
  repositoryNames,
  runtimeBadge,
  setRepositoryEnabled,
  writePort,
  writeRepository,
  writeRepositoryField,
} from './serviceDraft.js';

/** Stable identity for "no ports declared", so the empty branch is a value test. */
const NO_PORTS: readonly PortSlot[] = [];

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
    edit((current) =>
      writeRepository(current, name, { ...newRepository(), name } as RepositoryDef),
    );
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
            isOpen={open.has(name)}
            projectBaseline={draft.baselineBranch}
            others={dependencyTargets(draft, name)}
            onToggle={() => toggle(name)}
            onWrite={(patch) => edit((current) => writeRepositoryField(current, name, patch))}
            onReplace={(next) => edit((current) => writeRepository(current, name, next))}
            onRename={(raw) => {
              const renamed = renameRepository(draft, name, raw);
              // A blank or duplicate name is refused; the re-render restores the
              // old value, exactly as the vanilla view does.
              if (renamed) edit(() => renamed);
            }}
            onRemove={() => edit((current) => writeRepository(current, name, null))}
            onTouch={(key) => touch(`${name}.${key}`)}
            onBrowsePath={() => send.browseRepoPath(name)}
            targetPorts={(target) => portsOf(draft, target)}
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
  isOpen,
  projectBaseline,
  others,
  onToggle,
  onWrite,
  onReplace,
  onRename,
  onRemove,
  onTouch,
  onBrowsePath,
  targetPorts,
  fieldError,
}: {
  readonly name: string;
  readonly repo: RepositoryDef;
  readonly isOpen: boolean;
  readonly projectBaseline: string | undefined;
  readonly others: readonly string[];
  readonly onToggle: () => void;
  readonly onWrite: (patch: Partial<RepositoryDef>) => void;
  readonly onReplace: (next: RepositoryDef) => void;
  readonly onRename: (raw: string) => void;
  readonly onRemove: () => void;
  readonly onTouch: (key: string) => void;
  readonly onBrowsePath: () => void;
  readonly targetPorts: (target: string) => readonly string[];
  readonly fieldError: (key: string) => string | undefined;
}) {
  const runnable = isRunnable(repo);
  const enabled = repo.enabled !== false;
  // `NO_PORTS` keeps a stable identity when there are no ports, so the empty
  // branch below is a value comparison rather than a truthiness test.
  const ports: readonly PortSlot[] = repo.service?.ports ?? NO_PORTS;

  return (
    <div className={`card ${isOpen ? 'open is-selected' : ''}`} data-card={name}>
      <div className="card-head roster-row repo-cols">
        {/*
          The disclosure is a real `<button aria-expanded>`, not the whole row —
          it used to be a bare div with `cursor:pointer`, no role and no keydown
          handler, which made the accordion entirely unusable by keyboard (UI-R09).
          The enable switch and Remove are SIBLINGS of the toggle, never
          descendants, so no interactive control nests inside another.
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
              onTouch('repoPath');
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
                  : { service: undefined },
              ),
          }}
        />

        {runnable && repo.service ? (
          <>
            <Field
              label="Run a Docker image"
              help="On, karst runs a container instead of a command in the worktree, publishes your allocated port onto it, and removes it when the ticket is torn down."
              control={{
                kind: 'checkbox',
                name: `f-svc-docker-mode-${name}`,
                checked: Boolean(repo.service.docker),
                onChange: (checked) =>
                  onWrite({
                    service: {
                      ...repo.service,
                      docker: checked
                        ? ({ image: '', containerPort: 0 } as unknown as ServiceDef['docker'])
                        : undefined,
                    } as ServiceDef,
                  }),
              }}
            />
            {repo.service.docker ? (
              <Field
                label="Image"
                error={fieldError(`${name}.docker.image`)}
                control={{
                  kind: 'input',
                  name: `f-svc-docker-image-${name}`,
                  value: repo.service.docker.image ?? '',
                  placeholder: 'postgres:16',
                  onChange: (value) => {
                    onTouch('docker.image');
                    onWrite({
                      service: {
                        ...repo.service,
                        docker: { ...(repo.service?.docker ?? { containerPort: 0 }), image: value },
                      } as ServiceDef,
                    });
                  },
                }}
              />
            ) : (
              <Field
                label="Start command"
                error={fieldError(`${name}.start`)}
                control={{
                  kind: 'input',
                  name: `f-svc-start-${name}`,
                  value: repo.service.start ?? '',
                  placeholder: 'npm run dev',
                  onChange: (value) => {
                    onTouch('start');
                    onWrite({ service: { ...repo.service, start: value } as ServiceDef });
                  },
                }}
              />
            )}
            <Field
              label="Health check"
              error={fieldError(`${name}.health`)}
              control={{
                kind: 'input',
                name: `f-svc-health-${name}`,
                value: repo.service.health ?? '',
                placeholder: 'http://{host}:{port}/health',
                onChange: (value) => {
                  onTouch('health');
                  onWrite({ service: { ...repo.service, health: value } as ServiceDef });
                },
              }}
            />
            <Field
              label="Verify instance identity"
              help="The service must echo KARST_INSTANCE_TOKEN back in the X-Karst-Instance header. Without it any 200 on the port counts as healthy — including another worktree's service."
              control={{
                kind: 'checkbox',
                name: `f-svc-health-identity-${name}`,
                checked: repo.service.healthIdentity === true,
                onChange: (checked) =>
                  onWrite({ service: { ...repo.service, healthIdentity: checked } as ServiceDef }),
              }}
            />

            <h2>Ports</h2>
            <PortRange
              name={name}
              range={repo.service.portRange}
              fieldError={fieldError}
              onTouch={onTouch}
              onChange={(range) =>
                onWrite({ service: { ...repo.service, portRange: range } as ServiceDef })
              }
            />
            {/*
              An EMPTY port list is not "nothing happens": the host falls back to
              probing the repository's package.json scripts, so the empty state
              says which fallback applies rather than showing a blank table.
            */}
            {ports.length === 0 ? (
              <div className="k-empty">
                <div className="k-empty-title">{emptyPortsNotice(repo)}</div>
              </div>
            ) : (
              <table className="sub">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Env</th>
                    <th>Default</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {ports.map((port, index) => (
                    <tr key={`${name}-port-${index}-${port.name}`}>
                      <td>
                        <Field
                          label={<span className="sr-only">{`Port ${index + 1} name`}</span>}
                          control={{
                            kind: 'input',
                            name: `f-svc-port-${name}-${index}-name`,
                            value: port.name,
                            placeholder: 'http',
                            onChange: (value) =>
                              onReplace(writePort(repo, index, { name: value })),
                          }}
                        />
                      </td>
                      <td>
                        <Field
                          label={<span className="sr-only">{`Port ${index + 1} environment variable`}</span>}
                          control={{
                            kind: 'input',
                            name: `f-svc-port-${name}-${index}-env`,
                            value: port.env,
                            placeholder: 'PORT',
                            onChange: (value) => onReplace(writePort(repo, index, { env: value })),
                          }}
                        />
                      </td>
                      <td>
                        <Field
                          label={<span className="sr-only">{`Port ${index + 1} default value`}</span>}
                          control={{
                            kind: 'input',
                            type: 'number',
                            name: `f-svc-port-${name}-${index}-default`,
                            value: String(port.default ?? ''),
                            placeholder: '3000',
                            onChange: (value) =>
                              onReplace(
                                writePort(repo, index, { default: portDefault(value) }),
                              ),
                          }}
                        />
                      </td>
                      <td>
                        <DestructiveButton
                          action="remove-port"
                          size="sm"
                          aria-label={`Remove port ${index + 1}`}
                          title={`Remove port ${index + 1}`}
                          onClick={() => onReplace(removePort(repo, index))}
                        >
                          &times;
                        </DestructiveButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <Button variant="secondary" size="sm" onClick={() => onReplace(addPort(repo))}>
              + Add port
            </Button>

            <h2>Depends on</h2>
            <Dependencies
              name={name}
              deps={repo.service.dependsOn ?? []}
              others={others}
              targetPorts={targetPorts}
              onWrite={(deps) =>
                onWrite({ service: { ...repo.service, dependsOn: deps } as ServiceDef })
              }
            />
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

/** The per-service port allocation window; blank inherits the global range. */
function PortRange({
  name,
  range,
  fieldError,
  onTouch,
  onChange,
}: {
  readonly name: string;
  readonly range: readonly [number, number] | undefined;
  readonly fieldError: (key: string) => string | undefined;
  readonly onTouch: (key: string) => void;
  readonly onChange: (next: [number, number] | undefined) => void;
}) {
  const min = range ? String(range[0]) : '';
  const max = range ? String(range[1]) : '';
  const error = fieldError(`${name}.portRange`);
  return (
    <>
      <div className="form-grid">
        <Field
          label="Port range minimum (blank inherits global)"
          error={error}
          control={{
            kind: 'input',
            type: 'number',
            name: `f-svc-port-min-${name}`,
            value: min,
            placeholder: 'min',
            onChange: (value) => {
              onTouch('portRange');
              const lo = portDefault(value);
              const hi = portDefault(max);
              onChange(lo === undefined || hi === undefined ? undefined : [lo, hi]);
            },
          }}
        />
        <Field
          label="Port range maximum"
          error={error}
          control={{
            kind: 'input',
            type: 'number',
            name: `f-svc-port-max-${name}`,
            value: max,
            placeholder: 'max',
            onChange: (value) => {
              onTouch('portRange');
              const hi = portDefault(value);
              const lo = portDefault(min);
              onChange(lo === undefined || hi === undefined ? undefined : [lo, hi]);
            },
          }}
        />
      </div>
    </>
  );
}

/**
 * The dependency list: each row names a target repository, a port on it, and the
 * binds that fill the target's environment.
 *
 * When nothing else is runnable there is nothing to depend on, and the Add
 * control says so rather than offering a list of empty options.
 */
function Dependencies({
  name,
  deps,
  others,
  targetPorts,
  onWrite,
}: {
  readonly name: string;
  readonly deps: readonly DependsOn[];
  readonly others: readonly string[];
  readonly targetPorts: (target: string) => readonly string[];
  readonly onWrite: (next: readonly DependsOn[]) => void;
}) {
  const add = (): void =>
    onWrite([
      ...deps.map((d) => ({ ...d, bind: [...d.bind] })),
      { target: others[0] ?? '', port: targetPorts(others[0] ?? '')[0] ?? '', bind: [] },
    ]);

  if (others.length === 0) {
    return (
      <>
        <div className="k-empty">
          <div className="k-empty-title">No other runnable repositories to depend on.</div>
        </div>
        <Button variant="secondary" size="sm" disabled title="No other runnable repositories to depend on">
          + Add dependency
        </Button>
      </>
    );
  }

  return (
    <>
      {deps.map((dep, i) => {
        const ports = targetPorts(dep.target);
        return (
          <div key={`${name}-dep-${i}-${dep.target}`} className="card" data-dep-card={i}>
            <div className="card-body">
              <div className="row">
                <Field
                  label={<span className="sr-only">{`Dependency ${i + 1} target repository`}</span>}
                  control={{
                    kind: 'select',
                    name: `f-dep-${name}-${i}-target`,
                    value: dep.target,
                    options: others.map((n) => ({ value: n, label: n })),
                    onChange: (target) =>
                      onWrite(
                        deps.map((d, j) =>
                          j === i ? { ...d, target, port: targetPorts(target)[0] ?? '' } : { ...d, bind: [...d.bind] },
                        ),
                      ),
                  }}
                />
                <Field
                  label={<span className="sr-only">{`Dependency ${i + 1} port`}</span>}
                  control={{
                    kind: 'select',
                    name: `f-dep-${name}-${i}-port`,
                    value: dep.port,
                    // A saved port the target no longer declares keeps its own
                    // option, so the dependency stays visible instead of
                    // silently reverting to the first port.
                    options: [
                      ...(dep.port !== '' && !ports.includes(dep.port)
                        ? [{ value: dep.port, label: dep.port }]
                        : []),
                      ...ports.map((p) => ({ value: p, label: p })),
                    ],
                    onChange: (port) =>
                      onWrite(deps.map((d, j) => (j === i ? { ...d, port } : { ...d, bind: [...d.bind] }))),
                  }}
                />
                <DestructiveButton
                  action="remove-binding"
                  size="sm"
                  onClick={() =>
                    onWrite(deps.filter((_, j) => j !== i).map((d) => ({ ...d, bind: [...d.bind] })))
                  }
                >
                  Remove
                </DestructiveButton>
              </div>
              {dep.bind.map((bind, bi) => (
                <div key={`${name}-bind-${i}-${bi}-${bind.env}`} className="bind-row">
                  <Field
                    label={<span className="sr-only">{`Dependency ${i + 1} bind ${bi + 1} environment variable`}</span>}
                    control={{
                      kind: 'input',
                      name: `f-bind-${name}-${i}-${bi}-env`,
                      value: bind.env,
                      placeholder: 'env',
                      onChange: (value) =>
                        onWrite(
                          deps.map((d, j) =>
                            j === i
                              ? {
                                  ...d,
                                  bind: d.bind.map((b, k) =>
                                    k === bi ? { ...b, env: value } : b,
                                  ),
                                }
                              : { ...d, bind: [...d.bind] },
                          ),
                        ),
                    }}
                  />
                  <Field
                    label={<span className="sr-only">{`Dependency ${i + 1} bind ${bi + 1} template`}</span>}
                    control={{
                      kind: 'input',
                      name: `f-bind-${name}-${i}-${bi}-template`,
                      value: bind.template,
                      placeholder: 'template, e.g. http://{host}:{port}',
                      onChange: (value) =>
                        onWrite(
                          deps.map((d, j) =>
                            j === i
                              ? {
                                  ...d,
                                  bind: d.bind.map((b, k) =>
                                    k === bi ? { ...b, template: value } : b,
                                  ),
                                }
                              : { ...d, bind: [...d.bind] },
                          ),
                        ),
                    }}
                  />
                  <DestructiveButton
                    action="remove-binding"
                    size="sm"
                    aria-label={`Remove bind ${bi + 1}`}
                    title={`Remove bind ${bi + 1}`}
                    onClick={() =>
                      onWrite(
                        deps.map((d, j) =>
                          j === i
                            ? { ...d, bind: d.bind.filter((_, k) => k !== bi) }
                            : { ...d, bind: [...d.bind] },
                        ),
                      )
                    }
                  >
                    &times;
                  </DestructiveButton>
                </div>
              ))}
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  onWrite(
                    deps.map((d, j) =>
                      j === i ? { ...d, bind: [...d.bind, { env: '', template: '' }] } : { ...d, bind: [...d.bind] },
                    ),
                  )
                }
              >
                + Add bind
              </Button>
            </div>
          </div>
        );
      })}
      <Button variant="secondary" size="sm" onClick={add}>
        + Add dependency
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
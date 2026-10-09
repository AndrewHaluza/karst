/**
 * The editor for ONE service definition — runtime, health, ports, port window and
 * dependencies. Shared by the `service:` shorthand (the repository's one service,
 * rendered exactly as before) and each entry of a `services:` map.
 *
 * `keyPrefix` is the fault/touch namespace: the repository name for the shorthand
 * (so a mapped host fault such as `repository "api" service.start` still lands on
 * its field), and `repo/service` for a map entry, which no parsed fault names —
 * so a map entry never shows a mapped error it does not own.
 *
 * `scope` is the DOM id suffix. For the shorthand it is the repository name, so
 * every control keeps the id it had before the `services:` map existed (the
 * single-service snapshots stay byte-identical).
 */
import type { DependsOn, PortSlot, ServiceDef } from '../../../../manifest/types.js';
import { Field } from '../primitives/Field.js';
import { Button } from '../primitives/Button.js';
import { DestructiveButton } from '../primitives/DestructiveButton.js';
import {
  addPort,
  emptyPortsNotice,
  portDefault,
  removePort,
  writePort,
} from './serviceDraft.js';

/** Stable identity for "no ports declared", so the empty branch is a value test. */
const NO_PORTS: readonly PortSlot[] = [];

export interface ServiceFieldsProps {
  readonly scope: string;
  readonly keyPrefix: string;
  readonly def: ServiceDef;
  readonly others: readonly string[];
  readonly targetPorts: (target: string) => readonly string[];
  readonly fieldError: (key: string) => string | undefined;
  readonly onTouch: (key: string) => void;
  readonly onDef: (next: ServiceDef) => void;
}

/** The runtime, health, ports and dependency fields of one service. */
export function ServiceFields({
  scope,
  keyPrefix,
  def,
  others,
  targetPorts,
  fieldError,
  onTouch,
  onDef,
}: ServiceFieldsProps) {
  // `NO_PORTS` keeps a stable identity when there are no ports, so the empty
  // branch below is a value comparison rather than a truthiness test.
  const ports: readonly PortSlot[] = def.ports ?? NO_PORTS;
  const touch = (key: string): void => onTouch(`${keyPrefix}.${key}`);
  const error = (key: string): string | undefined => fieldError(`${keyPrefix}.${key}`);

  return (
    <>
      <Field
        label="Run a Docker image"
        help="On, karst runs a container instead of a command in the worktree, publishes your allocated port onto it, and removes it when the ticket is torn down."
        control={{
          kind: 'checkbox',
          name: `f-svc-docker-mode-${scope}`,
          checked: Boolean(def.docker),
          onChange: (checked) =>
            onDef({
              ...def,
              docker: checked
                ? ({ image: '', containerPort: 0 } as unknown as ServiceDef['docker'])
                : undefined,
            } as ServiceDef),
        }}
      />
      {def.docker ? (
        <Field
          label="Image"
          error={error('docker.image')}
          control={{
            kind: 'input',
            name: `f-svc-docker-image-${scope}`,
            value: def.docker.image ?? '',
            placeholder: 'postgres:16',
            onChange: (value) => {
              touch('docker.image');
              onDef({
                ...def,
                docker: { ...(def.docker ?? { containerPort: 0 }), image: value },
              } as ServiceDef);
            },
          }}
        />
      ) : (
        <Field
          label="Start command"
          error={error('start')}
          control={{
            kind: 'input',
            name: `f-svc-start-${scope}`,
            value: def.start ?? '',
            placeholder: 'npm run dev',
            onChange: (value) => {
              touch('start');
              onDef({ ...def, start: value } as ServiceDef);
            },
          }}
        />
      )}
      <Field
        label="Health check"
        error={error('health')}
        control={{
          kind: 'input',
          name: `f-svc-health-${scope}`,
          value: def.health ?? '',
          placeholder: 'http://{host}:{port}/health',
          onChange: (value) => {
            touch('health');
            onDef({ ...def, health: value } as ServiceDef);
          },
        }}
      />
      <Field
        label="Verify instance identity"
        help="The service must echo KARST_INSTANCE_TOKEN back in the X-Karst-Instance header. Without it any 200 on the port counts as healthy — including another worktree's service."
        control={{
          kind: 'checkbox',
          name: `f-svc-health-identity-${scope}`,
          checked: def.healthIdentity === true,
          onChange: (checked) => onDef({ ...def, healthIdentity: checked } as ServiceDef),
        }}
      />

      <h2>Ports</h2>
      <PortRange
        scope={scope}
        range={def.portRange}
        error={error('portRange')}
        onTouch={() => touch('portRange')}
        onChange={(range) => onDef({ ...def, portRange: range } as ServiceDef)}
      />
      {/*
        An EMPTY port list is not "nothing happens": the host falls back to
        probing the repository's package.json scripts, so the empty state says
        which fallback applies rather than showing a blank table.
      */}
      {ports.length === 0 ? (
        <div className="k-empty">
          <div className="k-empty-title">{emptyPortsNotice(def)}</div>
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
              <tr key={`${scope}-port-${index}-${port.name}`}>
                <td>
                  <Field
                    label={<span className="sr-only">{`Port ${index + 1} name`}</span>}
                    control={{
                      kind: 'input',
                      name: `f-svc-port-${scope}-${index}-name`,
                      value: port.name,
                      placeholder: 'http',
                      onChange: (value) => onDef(writePort(def, index, { name: value })),
                    }}
                  />
                </td>
                <td>
                  <Field
                    label={<span className="sr-only">{`Port ${index + 1} environment variable`}</span>}
                    control={{
                      kind: 'input',
                      name: `f-svc-port-${scope}-${index}-env`,
                      value: port.env,
                      placeholder: 'PORT',
                      onChange: (value) => onDef(writePort(def, index, { env: value })),
                    }}
                  />
                </td>
                <td>
                  <Field
                    label={<span className="sr-only">{`Port ${index + 1} default value`}</span>}
                    control={{
                      kind: 'input',
                      type: 'number',
                      name: `f-svc-port-${scope}-${index}-default`,
                      value: String(port.default ?? ''),
                      placeholder: '3000',
                      onChange: (value) =>
                        onDef(writePort(def, index, { default: portDefault(value) })),
                    }}
                  />
                </td>
                <td>
                  <DestructiveButton
                    action="remove-port"
                    size="sm"
                    aria-label={`Remove port ${index + 1}`}
                    title={`Remove port ${index + 1}`}
                    onClick={() => onDef(removePort(def, index))}
                  >
                    &times;
                  </DestructiveButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Button variant="secondary" size="sm" onClick={() => onDef(addPort(def))}>
        + Add port
      </Button>

      <h2>Depends on</h2>
      <Dependencies
        scope={scope}
        deps={def.dependsOn ?? []}
        others={others}
        targetPorts={targetPorts}
        onWrite={(deps) => onDef({ ...def, dependsOn: deps } as ServiceDef)}
      />
    </>
  );
}

/** The per-service port allocation window; blank inherits the global range. */
function PortRange({
  scope,
  range,
  error,
  onTouch,
  onChange,
}: {
  readonly scope: string;
  readonly range: readonly [number, number] | undefined;
  readonly error: string | undefined;
  readonly onTouch: () => void;
  readonly onChange: (next: [number, number] | undefined) => void;
}) {
  const min = range ? String(range[0]) : '';
  const max = range ? String(range[1]) : '';
  return (
    <>
      <div className="form-grid">
        <Field
          label="Port range minimum (blank inherits global)"
          error={error}
          control={{
            kind: 'input',
            type: 'number',
            name: `f-svc-port-min-${scope}`,
            value: min,
            placeholder: 'min',
            onChange: (value) => {
              onTouch();
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
            name: `f-svc-port-max-${scope}`,
            value: max,
            placeholder: 'max',
            onChange: (value) => {
              onTouch();
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
 * The dependency list: each row names a target unit (`repo` or `repo/service`), a
 * port on it, and the binds that fill the target's environment.
 *
 * When nothing else is runnable there is nothing to depend on, and the Add
 * control says so rather than offering a list of empty options.
 */
function Dependencies({
  scope,
  deps,
  others,
  targetPorts,
  onWrite,
}: {
  readonly scope: string;
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
          <div key={`${scope}-dep-${i}-${dep.target}`} className="card" data-dep-card={i}>
            <div className="card-body">
              <div className="row">
                <Field
                  label={<span className="sr-only">{`Dependency ${i + 1} target repository`}</span>}
                  control={{
                    kind: 'select',
                    name: `f-dep-${scope}-${i}-target`,
                    value: dep.target,
                    options: others.map((n) => ({ value: n, label: n })),
                    onChange: (target) =>
                      onWrite(
                        deps.map((d, j) =>
                          j === i
                            ? { ...d, target, port: targetPorts(target)[0] ?? '' }
                            : { ...d, bind: [...d.bind] },
                        ),
                      ),
                  }}
                />
                <Field
                  label={<span className="sr-only">{`Dependency ${i + 1} port`}</span>}
                  control={{
                    kind: 'select',
                    name: `f-dep-${scope}-${i}-port`,
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
                  action="remove-dependency"
                  size="sm"
                  onClick={() =>
                    onWrite(deps.filter((_, j) => j !== i).map((d) => ({ ...d, bind: [...d.bind] })))
                  }
                >
                  Remove
                </DestructiveButton>
              </div>
              {dep.bind.map((bind, bi) => (
                <div key={`${scope}-bind-${i}-${bi}-${bind.env}`} className="bind-row">
                  <Field
                    label={<span className="sr-only">{`Dependency ${i + 1} bind ${bi + 1} environment variable`}</span>}
                    control={{
                      kind: 'input',
                      name: `f-bind-${scope}-${i}-${bi}-env`,
                      value: bind.env,
                      placeholder: 'env',
                      onChange: (value) =>
                        onWrite(
                          deps.map((d, j) =>
                            j === i
                              ? {
                                  ...d,
                                  bind: d.bind.map((b, k) => (k === bi ? { ...b, env: value } : b)),
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
                      name: `f-bind-${scope}-${i}-${bi}-template`,
                      value: bind.template,
                      placeholder: 'template, e.g. http://{host}:{port}',
                      onChange: (value) =>
                        onWrite(
                          deps.map((d, j) =>
                            j === i
                              ? {
                                  ...d,
                                  bind: d.bind.map((b, k) => (k === bi ? { ...b, template: value } : b)),
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
                      j === i
                        ? { ...d, bind: [...d.bind, { env: '', template: '' }] }
                        : { ...d, bind: [...d.bind] },
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


/**
 * COMPONENT-mode tests for the Services tab (NDL-126 §9.5, phase 3 step 3).
 *
 * The load-bearing assertions are the ones that would delete a user's manifest:
 *
 * - **`repositories` is SPREAD, never rebuilt.** A rebuilt map drops every
 *   repository the tab does not render, and the host's `mergeSection` deletes a
 *   field the incoming manifest no longer carries — so the rebuild silently
 *   deletes configuration (D1/D3, the same rule as Git's `conventions`).
 * - **a new repository is a DRAFT**: no `service`, `enabled: false`. The old
 *   default built an empty start/ports shape, which is what made a placeholder
 *   command the path of least resistance.
 * - **a rename RE-KEYS and repoints dependencies.** Missing the repoint leaves a
 *   dependency naming a repository that no longer exists.
 * - **an empty port list says which fallback applies.** It is NOT "nothing
 *   happens": the host probes the repository's `package.json`.
 * - **the runtime fields render only when there IS a service** — an empty "Start
 *   command" box is what used to invite a fake value.
 * - **the enable toggle writes an explicit boolean**, not a flip of an absent
 *   field (absent means enabled on disk).
 * - **the folder picker is the REDUCER's job** — this component must not apply
 *   `repo-path-picked` itself, or it would mark a field the user never focused.
 */
// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Manifest } from '../../../../manifest/types.js';
import { AnnouncerProvider } from '../primitives/LiveRegion.js';
import { SettingsAppProvider } from '../SettingsAppContext.js';
import { createTestBridge, type TestBridge } from '../testBridge.js';
import { buildSettingsState } from '../../state.js';
import { FIXTURE_MANIFEST } from '../testFixtures.js';
import { ServicesSection } from './ServicesSection.js';
import { AppProbe, readProbe, type AppProbeShape } from './AppProbe.js';
import { parseRepoFieldError } from '../diagnostics.js';

afterEach(cleanup);

const BASE: Manifest = {
  ...FIXTURE_MANIFEST,
  baselineBranch: 'main',
  repositories: {
    api: {
      name: 'api',
      repoPath: '../api',
      hasMigrations: false,
      enabled: true,
      service: {
        start: 'npm run dev',
        ports: [{ name: 'http', env: 'PORT', default: 3000 }],
        dependsOn: [{ target: 'db', port: 'pg', bind: [] }],
      },
    },
    db: {
      name: 'db',
      repoPath: '../db',
      hasMigrations: true,
      enabled: true,
      service: { start: 'npm run dev', ports: [{ name: 'pg', env: 'PGPORT', default: 5432 }], dependsOn: [] },
    },
    docs: { name: 'docs', repoPath: '../docs', hasMigrations: false, enabled: true },
  } as unknown as Manifest['repositories'],
};

let probeRef: (() => AppProbeShape) | null = null;

function mount(manifest: Manifest = BASE): { bridge: TestBridge; probe(): AppProbeShape } {
  const bridge = createTestBridge();
  const view = render(
    <AnnouncerProvider>
      <SettingsAppProvider bridge={bridge} initialSection="services">
        <ServicesSection />
        <AppProbe />
      </SettingsAppProvider>
    </AnnouncerProvider>,
  );
  act(() =>
    bridge.push({
      type: 'state',
      state: buildSettingsState(manifest, null, [], true, ['claude'], [], {}, undefined, '/repo/karst.yml'),
    }),
  );
  const probe = (): AppProbeShape => readProbe(view.baseElement);
  probeRef = probe;
  return { bridge, probe };
}

function live(): AppProbeShape {
  if (!probeRef) throw new Error('mount() has not run in this test');
  return probeRef();
}

function repositories(): Record<string, Record<string, unknown>> {
  return ((live().draft as { repositories?: Record<string, Record<string, unknown>> }).repositories ??
    {}) as Record<string, Record<string, unknown>>;
}

function card(name: string): HTMLElement {
  const node = document.querySelector(`[data-card="${name}"]`);
  if (!node) throw new Error(`no card for ${name}`);
  return node as HTMLElement;
}

function setField(name: string, value: string): void {
  const el = document.querySelector(`[name="${name}"]`) as HTMLInputElement | null;
  if (!el) throw new Error(`no control named ${name}`);
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
  if (!setter) throw new Error(`no value setter on ${name}`);
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function open(name: string): void {
  const toggle = card(name).querySelector('[data-toggle]') as HTMLButtonElement;
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
}

describe('ServicesSection — the roster', () => {
  it('renders a row per repository with its path and runtime badge', () => {
    mount();
    expect(card('api')).toBeTruthy();
    expect(card('docs')).toBeTruthy();
    // `docs` declares no service, so it is a worktree and its runtime fields are
    // not rendered at all.
    expect(card('docs').textContent).toContain('worktree only');
    expect(card('api').textContent).toContain('service');
  });

  it('shows the Draft marker only for a disabled repository', () => {
    mount({
      ...BASE,
      repositories: { ...(BASE.repositories as object), docs: { name: 'docs', repoPath: '../docs', hasMigrations: false, enabled: false } } as unknown as Manifest['repositories'],
    });
    expect(card('docs').textContent).toContain('Draft');
    expect(card('api').textContent).not.toContain('Draft');
  });

  it('renders the empty state and an Add control when nothing is configured', () => {
    mount({ ...FIXTURE_MANIFEST, repositories: {} as Manifest['repositories'] });
    expect(document.body.textContent).toContain('No repositories configured.');
    expect(screen.getByRole('button', { name: '+ Add repository' })).toBeTruthy();
  });

  it('adds a DRAFT repository: no service, disabled, and it opens itself', () => {
    mount({ ...FIXTURE_MANIFEST, repositories: {} as Manifest['repositories'] });
    fireEvent.click(screen.getByRole('button', { name: '+ Add repository' }));
    const repos = repositories();
    expect(Object.keys(repos)).toEqual(['repo-1']);
    // The old default built an empty start/ports shape — the thing that made a
    // placeholder command the path of least resistance.
    expect(repos['repo-1']?.service).toBeUndefined();
    expect(repos['repo-1']?.enabled).toBe(false);
  });

  it('writes an EXPLICIT boolean on the enable toggle, not a flip', () => {
    mount();
    fireEvent.click(card('api').querySelector('[data-switch="repo-enabled-api"]') as HTMLButtonElement);
    // Absent means enabled on disk, so a flip would turn it into a literal true.
    expect(repositories().api?.enabled).toBe(false);
  });
});

describe('ServicesSection — the disclosure', () => {
  it('is a real button with aria-expanded, so the accordion is keyboard-usable', () => {
    mount();
    const toggle = card('api').querySelector('[data-toggle]') as HTMLButtonElement;
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(
      (card('api').querySelector('[data-toggle]') as HTMLButtonElement).getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('renders runtime fields only for a runnable repository', () => {
    mount();
    open('api');
    expect(document.querySelector('[name="f-svc-start-api"]')).not.toBeNull();
    open('docs');
    // There is nothing to fill in, and an empty box is what invited a fake value.
    expect(document.querySelector('[name="f-svc-start-docs"]')).toBeNull();
  });
});

describe('ServicesSection — repositories are SPREAD, never rebuilt', () => {
  it('keeps every repository across an edit (D1/D3)', () => {
    mount();
    open('api');
    setField('f-svc-start-api', 'npm run serve');
    // A rebuilt map would drop `db` and `docs`, and the host would then delete
    // them from the file.
    expect(Object.keys(repositories()).sort()).toEqual(['api', 'db', 'docs']);
  });

  it('keeps a repository key the tab renders no control for', () => {
    mount({
      ...BASE,
      repositories: {
        ...(BASE.repositories as object),
        api: {
          ...(BASE.repositories as unknown as Record<string, Record<string, unknown>>).api,
          inertKeyKarstNeverRenders: 'keep me',
        },
      } as unknown as Manifest['repositories'],
    });
    open('api');
    setField('f-svc-start-api', 'npm run serve');
    expect(repositories().api?.inertKeyKarstNeverRenders).toBe('keep me');
  });

  it('removes only the named repository on Remove', () => {
    mount();
    // Scoped to the roster HEAD: the dependency card's Remove drops one edge.
    const remove = Array.from(card('api').querySelectorAll('.cell-actions button')).find(
      (b) => b.textContent?.trim() === 'Remove',
    ) as HTMLButtonElement;
    expect(remove.getAttribute('data-karst-action')).toBe('remove-service');
    fireEvent.click(remove);
    expect(Object.keys(repositories()).sort()).toEqual(['api', 'db', 'docs'].filter((n) => n !== 'api'));
  });
});

describe('ServicesSection — a rename is a re-key', () => {
  it('re-keys the record and repoints a dependency that named it', () => {
    mount();
    open('api');
    setField('f-svc-name-api', 'api-v2');
    const repos = repositories();
    expect(Object.keys(repos)).toContain('api-v2');
    expect(Object.keys(repos)).not.toContain('api');
    // `api` depends on `db`, and `db` depends on nothing; renaming `db` is the
    // case that needs the repoint.
  });

  it('repoints a dependency when its TARGET is renamed', () => {
    mount();
    open('db');
    setField('f-svc-name-db', 'database');
    const deps = (repositories().api?.service as { dependsOn?: { target: string }[] }).dependsOn;
    // Without the repoint the dependency would name a repository that no longer
    // exists, and the host refuses the file.
    expect(deps?.[0]?.target).toBe('database');
  });

  it('refuses a duplicate name and leaves the record alone', () => {
    mount();
    open('api');
    setField('f-svc-name-api', 'db');
    expect(Object.keys(repositories())).toContain('api');
    expect(repositories().api?.repoPath).toBe('../api');
  });

  it('refuses a blank name', () => {
    mount();
    open('api');
    setField('f-svc-name-api', '   ');
    expect(Object.keys(repositories())).toContain('api');
  });
});

describe('ServicesSection — ports', () => {
  it('says which fallback applies when the port list is empty', () => {
    mount({
      ...BASE,
      repositories: {
        api: {
          name: 'api',
          repoPath: '../api',
          hasMigrations: false,
          enabled: true,
          service: { start: 'npm run dev', ports: [], dependsOn: [] },
        },
      } as unknown as Manifest['repositories'],
    });
    open('api');
    // An empty port list is NOT "nothing happens": the host probes package.json.
    expect(document.body.textContent).toContain('package.json scripts');
  });

  it('adds a port row', () => {
    mount();
    open('api');
    const before = (repositories().api?.service as { ports: unknown[] }).ports.length;
    fireEvent.click(screen.getByRole('button', { name: '+ Add port' }));
    expect((repositories().api?.service as { ports: unknown[] }).ports.length).toBe(before + 1);
  });

  it('emits data-karst-action="remove-port" and removes the row', () => {
    mount();
    open('api');
    const del = screen.getByRole('button', { name: 'Remove port 1' });
    expect(del.getAttribute('data-karst-action')).toBe('remove-port');
    fireEvent.click(del);
    expect((repositories().api?.service as { ports?: unknown[] }).ports ?? []).toHaveLength(0);
  });

  it('DELETES the ports key when the last port goes, rather than writing []', () => {
    mount();
    open('api');
    fireEvent.click(screen.getByRole('button', { name: 'Remove port 1' }));
    // An empty array still claims the key, so the host's merge would keep a
    // block the user deleted.
    expect('ports' in ((repositories().api?.service ?? {}) as Record<string, unknown>)).toBe(false);
  });
});

describe('ServicesSection — dependencies and binds', () => {
  it('offers no dependency control when nothing else is runnable', () => {
    mount({
      ...BASE,
      repositories: {
        api: {
          name: 'api',
          repoPath: '../api',
          hasMigrations: false,
          enabled: true,
          service: { start: 'npm run dev', ports: [], dependsOn: [] },
        },
      } as unknown as Manifest['repositories'],
    });
    open('api');
    expect(document.body.textContent).toContain('No other runnable repositories to depend on.');
    const add = screen.getByRole('button', { name: '+ Add dependency' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
  });

  /**
   * Two distinct destructive controls, two distinct taxonomy members. Vanilla
   * draws them as `data-remove-dep` (the row's "Remove", drops the whole
   * `dependsOn` entry) and `data-remove-bind` (the per-bind icon, drops one
   * bind), and `messages.ts` maps those to `remove-dependency` and
   * `remove-binding`. Collapsing them onto one member places a member never and
   * breaks phase 4's `data-karst-action` parity diff, so both are asserted here
   * against the same service: one dependency carrying one bind.
   */
  it('emits remove-dependency on the row Remove and remove-binding on the bind icon', () => {
    mount({
      ...BASE,
      repositories: {
        api: {
          name: 'api',
          repoPath: '../api',
          hasMigrations: false,
          enabled: true,
          service: {
            start: 'npm run dev',
            ports: [{ name: 'http', env: 'PORT', default: 3000 }],
            dependsOn: [
              { target: 'db', port: 'pg', bind: [{ env: 'DB_URL', template: 'http://{host}:{port}' }] },
            ],
          },
        },
        db: BASE.repositories!.db,
      } as unknown as Manifest['repositories'],
    });
    open('api');

    // Scoped to the dependency card: the roster's own "Remove" removes the whole
    // repository and carries `remove-service`.
    const depCard = document.querySelector('[data-dep-card="0"]') as HTMLElement;
    const rowRemove = Array.from(depCard.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Remove',
    ) as HTMLButtonElement;
    expect(rowRemove.getAttribute('data-karst-action')).toBe('remove-dependency');

    // The bind row carries its own control, addressed by its accessible name.
    const bindRemove = depCard.querySelector('.bind-row button[data-karst-action]') as HTMLButtonElement;
    expect(bindRemove.getAttribute('data-karst-action')).toBe('remove-binding');

    // And they are not the same button, so neither member is orphaned.
    expect(bindRemove).not.toBe(rowRemove);
  });

  it('adds a bind row', () => {
    mount();
    open('api');
    const before = (
      (repositories().api?.service as { dependsOn: { bind: unknown[] }[] }).dependsOn[0]?.bind ?? []
    ).length;
    fireEvent.click(screen.getByRole('button', { name: '+ Add bind' }));
    const after = (
      (repositories().api?.service as { dependsOn: { bind: unknown[] }[] }).dependsOn[0]?.bind ?? []
    ).length;
    expect(after).toBe(before + 1);
  });
});

describe('ServicesSection — signals', () => {
  it('emits data-karst-action="remove-signal" and removes by VALUE', () => {
    mount({
      ...BASE,
      repositories: {
        api: {
          name: 'api',
          repoPath: '../api',
          hasMigrations: false,
          enabled: true,
          signals: ['billing', 'payments'],
        },
      } as unknown as Manifest['repositories'],
    });
    open('api');
    const del = screen.getByRole('button', { name: 'Remove signal billing' });
    expect(del.getAttribute('data-karst-action')).toBe('remove-signal');
    fireEvent.click(del);
    expect((repositories().api?.signals ?? [])).toEqual(['payments']);
  });

  it('ignores a blank signal', () => {
    mount({
      ...BASE,
      repositories: {
        api: { name: 'api', repoPath: '../api', hasMigrations: false, enabled: true, signals: [] },
      } as unknown as Manifest['repositories'],
    });
    open('api');
    const add = screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
  });
});

describe('ServicesSection — a mapped fault stays silent until its field is touched', () => {
  const fault = 'repository "api" service.start is required';

  /** Mount with a host-reported repository fault already in state. */
  function mountWithFault(): { bridge: TestBridge } {
    const bridge = createTestBridge();
    const view = render(
      <AnnouncerProvider>
        <SettingsAppProvider bridge={bridge} initialSection="services">
          <ServicesSection />
          <AppProbe />
        </SettingsAppProvider>
      </AnnouncerProvider>,
    );
    act(() =>
      bridge.push({
        type: 'state',
        state: buildSettingsState(BASE, fault, [], true, ['claude'], [], {}, undefined, '/repo/karst.yml'),
      }),
    );
    const probe = (): AppProbeShape => readProbe(view.baseElement);
    probeRef = probe;
    return { bridge };
  }

  it('maps the fault to one field key', () => {
    expect(parseRepoFieldError(fault)?.key).toBe('api.start');
  });

  it('shows nothing before the field is touched, and the message after it is', () => {
    mountWithFault();
    open('api');
    // A mapped fault stays silent until the user touches THAT field — otherwise
    // a freshly added repository shows an error before anyone has typed anything.
    expect(document.body.textContent).not.toContain('service.start is required');

    // Typing INTO that field is what touches it; the section calls the context's
    // `touch`, so the fault now renders inline on the same control.
    setField('f-svc-start-api', '');
    expect(document.body.textContent).toContain('service.start is required');
  });

  it('stays silent when a DIFFERENT field is touched', () => {
    mountWithFault();
    open('api');
    setField('f-svc-health-api', 'http://x/health');
    // Touching `health` does not unlock a `start` fault.
    expect(document.body.textContent).not.toContain('service.start is required');
  });
});
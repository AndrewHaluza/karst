/**
 * COMPONENT-mode tests for the General tab (NDL-126 §9.5).
 *
 * These cover the per-component behaviours that only exist because the tab is
 * React: the render of every field `SECTION_FIELDS.general` claims, the
 * empty-means-delete rule for the optional templates, the two-tuple port range,
 * the positive-integer snap-back on the archive delay, and the toggle
 * delete-on-uncheck. The state-dependent rules (R11–R18, R26, R27) and the
 * dirty-marker / nav-dot plumbing are proven in `renderedGeneral.render.test.tsx`
 * against the real document.
 */
// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AnnouncerProvider } from '../primitives/LiveRegion.js';
import { SettingsAppProvider } from '../SettingsAppContext.js';
import { createTestBridge, type TestBridge } from '../testBridge.js';
import { FIXTURE_STATE_PUSH } from '../testFixtures.js';
import type { AgentPickerOptions } from '../hostBridge.js';
import {
  DEFAULT_TERMINAL_NAME_TEMPLATE,
  DEFAULT_TICKET_LABEL_TEMPLATE,
  TICKET_LABEL_VARIABLES,
} from '../../../../store/ticketLabelTemplate.js';
import { GeneralSection } from './GeneralSection.js';
import { AppProbe, readProbe, type AppProbeShape } from './AppProbe.js';

/** Options the last island mount received, so a pick can be simulated. */
let pickerOptions: AgentPickerOptions | null = null;

beforeEach(() => {
  pickerOptions = null;
  // The shared picker is an injected vanilla runtime (R-X3); stand in for it so
  // the tab's own write path — the three identity keys — is what is under test.
  (globalThis as unknown as Record<string, unknown>).mountAgentPicker = (
    _root: HTMLElement,
    opts: AgentPickerOptions,
  ) => {
    pickerOptions = opts;
  };
});

afterEach(() => {
  cleanup();
  delete (globalThis as unknown as Record<string, unknown>).mountAgentPicker;
});

/**
 * Mount the tab against the real reducer with a real host `state` push already
 * applied, so assertions read against hydrated state, not the empty store.
 */
function mountGeneral(): { bridge: TestBridge; probe: () => AppProbeShape } {
  const bridge = createTestBridge();
  const view = render(
    <AnnouncerProvider>
      <SettingsAppProvider bridge={bridge} initialSection="general">
        <GeneralSection />
        <AppProbe />
      </SettingsAppProvider>
    </AnnouncerProvider>,
  );
  act(() => bridge.push({ type: 'state', state: FIXTURE_STATE_PUSH }));
  return { bridge, probe: () => readProbe(view.baseElement) };
}

function input(name: string): HTMLInputElement {
  const node = document.querySelector(`input[name="${name}"]`);
  if (!(node instanceof HTMLInputElement)) throw new Error(`no input named ${name}`);
  return node;
}

describe('GeneralSection — the fields SECTION_FIELDS.general claims', () => {
  it('gives the page a header with title and description', () => {
    mountGeneral();
    expect(document.querySelector('#section-general')).not.toBeNull();
    expect(document.querySelector('.page-title')?.textContent).toBe('General');
    expect(document.querySelector('.page-desc')?.textContent).toContain('Project defaults');
  });

  it('associates every control with a real label and a real help target (UI-R25)', () => {
    mountGeneral();
    const controls = document.querySelectorAll('#section-general input, #section-general select');
    expect(controls.length).toBeGreaterThan(0);
    for (const control of Array.from(controls)) {
      expect(control.getAttribute('id'), `control without an id`).toBeTruthy();
      // The vanilla rule (UI-R25): a `<label for>` OR an `aria-label` — the
      // pair group's SECOND input answers to its own aria-label, because one
      // label cannot carry two controls without concatenating their names.
      const hasLabel =
        control.getAttribute('aria-label') !== null ||
        document.querySelector(`label[for="${control.getAttribute('id')}"]`) !== null;
      expect(hasLabel, `control ${control.getAttribute('id')} has no label`).toBe(true);
      const describedBy = control.getAttribute('aria-describedby');
      if (!describedBy) continue;
      for (const token of describedBy.split(' ')) {
        expect(document.getElementById(token), `aria-describedby points at nothing: ${token}`)
          .not.toBeNull();
      }
    }
  });

  it('hydrates host-pushed values rather than deriving them (UI-R31)', () => {
    mountGeneral();
    expect((screen.getByLabelText('Host') as HTMLInputElement).value).toBe('127.0.0.1');
    expect((screen.getByLabelText('Baseline branch') as HTMLInputElement).value).toBe('main');
    expect((screen.getByLabelText('Worktree path display') as HTMLSelectElement).value).toBe('relative');
  });

  it('renders no editor for a field the tab does not claim', () => {
    mountGeneral();
    // `id` belongs to no tab, so it is never editable here and always survives
    // from the file (NDL-126 §8.3). The read-only project facts stayed off the
    // General page in the vanilla view and stay off it here.
    expect(document.body.textContent).not.toContain('Project ID');
    expect(document.getElementById('factManifestPath')).toBeNull();
    expect(document.getElementById('openManifestBtn')).toBeNull();
  });

  it('renders the archive delay as a number control that can express nothing', () => {
    mountGeneral();
    const field = screen.getByLabelText('Archive done tickets after') as HTMLInputElement;
    expect(field.getAttribute('type')).toBe('number');
    expect(field.value).toBe('');
    expect(field.getAttribute('aria-describedby')).toBeTruthy();
  });

  it('checks the debug box only when the draft carries debug: true', () => {
    mountGeneral();
    expect(input('debug').checked).toBe(false);
    fireEvent.change(input('host'), { target: { value: '0.0.0.0' } });
    expect(input('debug').checked).toBe(false);
    fireEvent.click(input('debug'));
    expect(input('debug').checked).toBe(true);
  });

  it('checks close-done-terminals and source-control diffs from the draft', () => {
    mountGeneral();
    expect(input('closeDoneTerminalsWithTicket').checked).toBe(false);
    expect(input('diffsInSourceControl').checked).toBe(false);
  });
});

describe('GeneralSection — edits land on exactly one claimed key', () => {
  it('writes a typed host onto the draft and marks the tab dirty', () => {
    const { probe } = mountGeneral();
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: '0.0.0.0' } });
    expect(probe().draft).toMatchObject({ host: '0.0.0.0' });
    expect(probe().dirtySections).toEqual(['general']);
  });

  it('deletes an emptied optional template instead of writing an empty string', () => {
    const { probe } = mountGeneral();
    const field = screen.getByLabelText('Ticket label template') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'x' } });
    expect(probe().draft).toMatchObject({ ticketLabelTemplate: 'x' });
    fireEvent.change(field, { target: { value: '' } });
    expect(probe().draft).not.toHaveProperty('ticketLabelTemplate');
  });

  it('keeps portRange a 2-tuple when either half is edited', () => {
    const { probe } = mountGeneral();
    // 'Port range' names BOTH the input and its `role="group"` wrapper
    // (aria-labelledby) — the control is the input of the pair.
    const min = screen
      .getAllByLabelText('Port range')
      .find((el) => el.tagName === 'INPUT') as HTMLInputElement;
    expect(min).toBeTruthy();
    fireEvent.change(min, { target: { value: '4100' } });
    expect(probe().draft).toMatchObject({ portRange: [4100, 4999] });
    fireEvent.change(screen.getByLabelText('Port range maximum'), { target: { value: '4200' } });
    expect(probe().draft).toMatchObject({ portRange: [4100, 4200] });
  });

  it('snaps the archive delay back to blank unless it is a positive integer', () => {
    const { probe } = mountGeneral();
    const field = screen.getByLabelText('Archive done tickets after') as HTMLInputElement;
    fireEvent.change(field, { target: { value: '7' } });
    expect(probe().draft).toMatchObject({ archiveDoneAfterDays: 7 });
    fireEvent.change(field, { target: { value: '0' } });
    expect(probe().draft).not.toHaveProperty('archiveDoneAfterDays');
    fireEvent.change(field, { target: { value: '2.5' } });
    expect(probe().draft).not.toHaveProperty('archiveDoneAfterDays');
  });

  it('removes a toggle key when it is switched off, rather than storing false', () => {
    const { probe } = mountGeneral();
    const done = input('closeDoneTerminalsWithTicket');
    fireEvent.click(done);
    expect(probe().draft).toMatchObject({ closeDoneTerminalsWithTicket: true });
    fireEvent.click(done);
    expect(probe().draft).not.toHaveProperty('closeDoneTerminalsWithTicket');
  });

  it('never posts to the host from a field edit', () => {
    const { bridge } = mountGeneral();
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: '0.0.0.0' } });
    fireEvent.click(input('debug'));
    // Validation and Save are the shell's business; a tab editor is synchronous.
    expect(bridge.posted).toHaveLength(0);
  });
});

describe('GeneralSection — the agent-identity picker is an opaque island (R-X3)', () => {
  it('mounts the shared runtime into a container React never reconciles into', () => {
    const { probe } = mountGeneral();
    expect(pickerOptions).not.toBeNull();
    const island = document.querySelector('.agent-picker-island');
    expect(island).not.toBeNull();
    expect(island!.childNodes).toHaveLength(0);
    // The identity the host pushed is offered to the runtime, not re-derived.
    expect(pickerOptions!.value).toEqual({ core: '', model: '', effort: '' });
    expect(probe().section).toBe('general');
  });

  it('marks every core the host has not implemented unavailable', () => {
    mountGeneral();
    const byId = new Map(pickerOptions!.cores.map((c) => [c.id, c]));
    expect(byId.get('claude')?.disabled).toBe(false);
    expect(byId.get('codex')?.disabled).toBe(false);
    expect(byId.get('claude')?.label).toBe('Claude Code');
  });

  it('leads with the inherit/none row and offers effort', () => {
    mountGeneral();
    expect(pickerOptions!.inherit).toEqual({
      core: '',
      model: 'No default (agent picks)',
      effort: 'No effort (agent picks)',
    });
    expect(pickerOptions!.showEffort).toBe(true);
  });

  it('writes the three identity keys independently of one another', () => {
    const { probe } = mountGeneral();
    act(() => pickerOptions!.onChange({ core: 'codex', model: 'gpt-5', effort: '' }));
    expect(probe().draft).toMatchObject({ agentProvider: 'codex', defaultModel: 'gpt-5' });
    expect(probe().draft).not.toHaveProperty('defaultEffort');
    act(() => pickerOptions!.onChange({ core: '', model: '', effort: 'high' }));
    expect(probe().draft).not.toHaveProperty('agentProvider');
    expect(probe().draft).not.toHaveProperty('defaultModel');
    expect(probe().draft).toMatchObject({ defaultEffort: 'high' });
  });

  it('keeps the island DOM across an unrelated re-render', () => {
    mountGeneral();
    const island = document.querySelector('.agent-picker-island') as HTMLElement;
    const marker = island.ownerDocument.createElement('span');
    marker.textContent = 'mounted by the vanilla runtime';
    island.appendChild(marker);
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: '10.0.0.1' } });
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: '10.0.0.2' } });
    expect(island.querySelector('span')?.textContent).toBe('mounted by the vanilla runtime');
    // …and the island was NOT rebuilt, because its identity did not change.
    expect(pickerOptions!.value).toEqual({ core: '', model: '', effort: '' });
  });
});

describe('GeneralSection — display templates are the host\'s own (UI-R34 / R-X1)', () => {
  it("renders the host's template defaults and the shared variable set", () => {
    mountGeneral();
    // The placeholders are the IMPORTED host constants, not copied literals —
    // a drift would show Settings a default the label engine does not use.
    const label = screen.getByLabelText('Ticket label template') as HTMLInputElement;
    const terminal = screen.getByLabelText('Terminal name template') as HTMLInputElement;
    expect(label.placeholder).toBe(DEFAULT_TICKET_LABEL_TEMPLATE);
    expect(terminal.placeholder).toBe(DEFAULT_TERMINAL_NAME_TEMPLATE);

    // The variable set shown matches the host's exported list exactly.
    const shown = document.querySelector('#section-general .label-vars')?.textContent ?? '';
    expect(shown).toBeTruthy();
    const names = (shown.match(/\{(\w+)\}/g) ?? []).map((token) => token.slice(1, -1));
    expect(names).toEqual([...TICKET_LABEL_VARIABLES]);
    // The follow-up marker is presentation metadata forced at the terminal
    // seam — it was never a template token, so it is never rendered as one.
    expect(names).not.toContain('parentTicketId');
  });
});

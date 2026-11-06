// @vitest-environment jsdom
/**
 * Window-reload persistence of the ticket form: the unsaved text fields go into
 * setState (debounced) under {karstPanel, draft}, are dropped on a successful
 * save, and are laid over the host's boot payload on restore.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { renderWebview, type RenderHandle } from '../testing/renderHarness.js';

function baseState(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'create', provider: 'manual', title: '', key: '', description: '',
    repos: [], approaches: [], agents: [], unclassified: [], attachments: [],
    ...over,
  };
}

let h: RenderHandle | null = null;
afterEach(() => { h?.close(); h = null; });

const settle = (ms = 400): Promise<void> => new Promise((r) => setTimeout(r, ms));

function type(v: RenderHandle, id: string, value: string): void {
  const input = v.query<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)!;
  input.value = value;
  input.dispatchEvent(new v.window.Event('input', { bubbles: true }));
}

describe('ticket form — draft persistence', () => {
  it('writes the changed fields and the identity into setState, debounced', async () => {
    h = renderWebview('ticketForm');
    h.receive({ type: 'state', state: baseState() });
    expect(h.state).toEqual({ karstPanel: { mode: 'create' } });
    type(h, 'title', 'Fix login');
    type(h, 'desc', 'Details');
    // debounced: nothing written for the edit yet
    expect(h.state).toEqual({ karstPanel: { mode: 'create' } });
    await settle();
    expect(h.state).toEqual({ karstPanel: { mode: 'create' }, draft: { title: 'Fix login', desc: 'Details' } });
  });

  it('records an edit form under its ticket id', () => {
    h = renderWebview('ticketForm');
    h.receive({ type: 'state', state: baseState({ mode: 'edit', ticketId: 7, title: 'T' }) });
    expect(h.state).toEqual({ karstPanel: { mode: 'edit', ticketId: 7 } });
  });

  it('lays the saved draft over the boot payload, which wins only for the changed fields', () => {
    h = renderWebview('ticketForm', {
      persistedState: { karstPanel: { mode: 'edit', ticketId: 7 }, draft: { desc: 'my unsaved text' } },
    });
    h.receive({ type: 'state', state: baseState({ mode: 'edit', ticketId: 7, title: 'Fresh title', description: 'fresh desc' }) });
    expect(h.query<HTMLInputElement>('#title')!.value).toBe('Fresh title');
    expect(h.query<HTMLTextAreaElement>('#desc')!.value).toBe('my unsaved text');
    // the restored draft is kept in the state for a second reload
    expect(h.state).toEqual({ karstPanel: { mode: 'edit', ticketId: 7 }, draft: { desc: 'my unsaved text' } });
  });

  it('restores a create form draft and enables the primary action', () => {
    h = renderWebview('ticketForm', { persistedState: { karstPanel: { mode: 'create' }, draft: { title: 'Typed title', intent: 'check it' } } });
    h.receive({ type: 'state', state: baseState() });
    expect(h.query<HTMLInputElement>('#title')!.value).toBe('Typed title');
    expect(h.query<HTMLTextAreaElement>('#intent')!.value).toBe('check it');
    expect(h.query<HTMLButtonElement>('#submitBtn')!.disabled).toBe(false);
  });

  it('ignores draft entries that are not text fields', () => {
    h = renderWebview('ticketForm', { persistedState: { karstPanel: { mode: 'create' }, draft: { title: 5, attachments: ['x'], bogus: 'y' } } });
    h.receive({ type: 'state', state: baseState() });
    expect(h.query<HTMLInputElement>('#title')!.value).toBe('');
    expect(h.state).toEqual({ karstPanel: { mode: 'create' } });
  });

  it('clears the draft after a successful save', async () => {
    h = renderWebview('ticketForm');
    h.receive({ type: 'state', state: baseState() });
    type(h, 'title', 'Fix login');
    h.click('#saveBtn');
    h.receive({ type: 'busy', what: 'save', on: true });
    h.receive({ type: 'busy', what: 'save', on: false });
    h.receive({ type: 'state', state: baseState({ mode: 'edit', ticketId: 9, title: 'Fix login' }) });
    await settle();
    expect(h.state).toEqual({ karstPanel: { mode: 'edit', ticketId: 9 } });
  });

  it('keeps the draft when the save fails', async () => {
    h = renderWebview('ticketForm');
    h.receive({ type: 'state', state: baseState() });
    type(h, 'title', 'Fix login');
    h.click('#saveBtn');
    h.receive({ type: 'busy', what: 'save', on: true });
    h.receive({ type: 'error', message: 'boom' });
    h.receive({ type: 'busy', what: 'save', on: false });
    await settle();
    expect(h.state).toEqual({ karstPanel: { mode: 'create' }, draft: { title: 'Fix login' } });
  });
  it('persists text that code wrote without an input event', async () => {
    h = renderWebview('ticketForm');
    h.receive({ type: 'state', state: baseState() });
    h.query<HTMLTextAreaElement>('#desc')!.value = 'improved by the agent';
    h.receive({ type: 'busy', what: 'analyze', on: false });
    await settle();
    expect(h.state).toEqual({ karstPanel: { mode: 'create' }, draft: { desc: 'improved by the agent' } });
  });

  it('records the description the brief buttons wrote, and the undo', async () => {
    h = renderWebview('ticketForm');
    h.receive({ type: 'state', state: baseState({ sourceRef: 'X1' }) });
    type(h, 'desc', 'my text');
    h.receive({ type: 'brief', brief: { title: 'T', description: 'D body', tags: [], comments: [], attachments: [], url: 'https://x.test/1' } });
    await settle();
    h.click('#briefUse');
    await settle();
    // The fetched brief also fills the empty Title; the test is about the description.
    expect((h.state as { draft: Record<string, string> }).draft.desc).toBe('D body');
    h.click('#briefUndo');
    await settle();
    expect((h.state as { draft: Record<string, string> }).draft.desc).toBe('my text');
  });

  it('keeps a cleared field empty when a later state push arrives', () => {
    h = renderWebview('ticketForm');
    h.receive({ type: 'state', state: baseState({ mode: 'edit', ticketId: 7, title: 'T', description: 'host text' }) });
    type(h, 'desc', '');
    h.receive({ type: 'state', state: baseState({ mode: 'edit', ticketId: 7, title: 'T', description: 'host text' }) });
    expect(h.query<HTMLTextAreaElement>('#desc')!.value).toBe('');
  });

  it('keeps the proposal identity after the form minted a draft row', () => {
    h = renderWebview('ticketForm');
    h.receive({ type: 'state', state: baseState({ mode: 'edit', ticketId: 9, prefilled: true }) });
    expect(h.state).toEqual({ karstPanel: { mode: 'create', prefilled: true } });
  });
  it('persists code that changed a field the user already edited', async () => {
    h = renderWebview('ticketForm');
    h.receive({ type: 'state', state: baseState() });
    type(h, 'desc', 'typed');
    await settle();
    h.query<HTMLTextAreaElement>('#desc')!.value = 'typed, then improved';
    h.receive({ type: 'busy', what: 'analyze', on: false });
    await settle();
    expect(h.state).toEqual({ karstPanel: { mode: 'create' }, draft: { desc: 'typed, then improved' } });
  });
  it('does not turn a host refill of an empty field into a draft', async () => {
    h = renderWebview('ticketForm');
    h.receive({ type: 'state', state: baseState({ description: '' }) });
    h.receive({ type: 'state', state: baseState({ description: 'host text' }) });
    h.receive({ type: 'busy', what: 'analyze', on: false });
    await settle();
    expect(h.state).toEqual({ karstPanel: { mode: 'create' } });
  });
  it('keeps text typed while a save is in flight', async () => {
    h = renderWebview('ticketForm');
    h.receive({ type: 'state', state: baseState() });
    type(h, 'title', 'Fix login');
    h.query<HTMLButtonElement>('#saveBtn')!.click();
    type(h, 'desc', 'typed during save');
    h.receive({ type: 'busy', what: 'save', on: false });
    await settle();
    expect(h.state).toEqual({ karstPanel: { mode: 'create' }, draft: { desc: 'typed during save' } });
  });

  it('saves the prefilled flag in the identity of a proposal review form', () => {
    h = renderWebview('ticketForm');
    h.receive({ type: 'state', state: baseState({ prefilled: true }) });
    expect(h.state).toEqual({ karstPanel: { mode: 'create', prefilled: true } });
  });
});

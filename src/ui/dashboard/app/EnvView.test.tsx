// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type { DashboardState } from '../state.js';
import { all, bodyHas, isHidden, mountOverlays, must, q, text, type OverlayHarness } from './fixtures/overlaysKit.js';

const stateWith = (envOverrides: DashboardState['envOverrides'] = { services: ['api', 'web'], values: { '*': { SHARED: 'yes' }, api: { APP_HISTORY_FEATURE: 'true' } } }): DashboardState =>
  ({ ticketId: 7, key: 'FEAT-7', title: 'Seven', envOverrides }) as unknown as DashboardState;
const area = (scope: string): HTMLTextAreaElement => must<HTMLTextAreaElement>(`[data-env-scope="${scope}"]`);
const type = (scope: string, value: string): void => void fireEvent.change(area(scope), { target: { value } });
const msg = (scope: string): string => must(`[data-env-scope="${scope}"]`).closest('section')!.querySelector('.msg')!.textContent ?? '';
const open = (h: OverlayHarness): void => h.act(() => h.overlays.openEnv());
const saveBtn = (scope: string): HTMLButtonElement => must<HTMLButtonElement>(`[data-env-save="${scope}"]`);
const sent = (h: OverlayHarness): Array<[string, string, string]> => h.send.envOverridesSave.mock.calls as Array<[string, string, string]>;
// The host answers a Save by its request id; the runtime settles the control from the same message.
const answer = (h: OverlayHarness, requestId: string, ok: boolean): void => {
  h.emit({ type: 'action-result', requestId, ok, message: ok ? undefined : 'nope' } as never);
  (globalThis as unknown as { karstSettle(id: string): void }).karstSettle(requestId); // what the page's own listener does
};

describe('EnvView', () => {
  it('starts hidden and draws nothing', () => {
    mountOverlays(stateWith());
    expect(isHidden('#envView')).toBe(true);
    expect(must('#envView').childElementCount).toBe(0);
    expect(bodyHas('env-nav')).toBe(false);
  });

  it('opens a section per scope showing what is saved, and posts nothing', () => {
    const h = mountOverlays(stateWith());
    open(h);
    expect(isHidden('#envView')).toBe(false);
    expect(bodyHas('env-nav')).toBe(true);
    expect(text('.dh-current')).toBe('Env variables');
    expect(all('.envscope .ename').map((n) => n.textContent)).toEqual(['All services', 'api', 'web']);
    expect(area('*').value).toBe('SHARED=yes');
    expect(area('api').value).toBe('APP_HISTORY_FEATURE=true');
    expect(area('web').value).toBe(''); // offered even with nothing saved
    expect(all('.envscope .ecount').map((n) => n.textContent)).toEqual(['1 variable', '1 variable', 'none set']);
    expect(Object.values(h.send).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });

  it('names the shared section only when the ticket scopes no runnable service', () => {
    const h = mountOverlays(stateWith({ services: [], values: {} }));
    open(h);
    expect(all('.envscope')).toHaveLength(1);
    expect(text('.elead:last-child')).toContain('scopes no runnable service');
  });

  it('remembers what was typed per scope through a push, and says so', () => {
    const h = mountOverlays(stateWith());
    open(h);
    type('web', 'PORT=5173');
    expect(msg('web')).toBe('Unsaved changes');
    const node = area('web');
    h.emit({ type: 'state', state: stateWith({ services: ['api', 'web'], values: { '*': { SHARED: 'no' } } }) });
    expect(area('web')).toBe(node); // the field is the same node, so focus and caret survive too
    expect(area('web').value).toBe('PORT=5173');
    expect(msg('web')).toBe('Unsaved changes');
    expect(area('*').value).toBe('SHARED=no'); // an untouched scope follows the host
  });

  it('Revert drops the draft and the message', () => {
    const h = mountOverlays(stateWith());
    open(h);
    type('api', 'X=1');
    fireEvent.click(must('[data-env-revert="api"]'));
    expect(area('api').value).toBe('APP_HISTORY_FEATURE=true');
    expect(msg('api')).toBe('');
  });

  it('Save posts the scope and the typed body with a request id and goes pending', () => {
    const h = mountOverlays(stateWith());
    open(h);
    type('api', 'APP_HISTORY_FEATURE=true\nNEW=1');
    const className = saveBtn('api').className;
    fireEvent.click(saveBtn('api'));
    expect(sent(h)).toEqual([['api', 'APP_HISTORY_FEATURE=true\nNEW=1', expect.stringMatching(/^req-/)]]);
    expect(saveBtn('api').getAttribute('aria-busy')).toBe('true');
    expect(saveBtn('api').className.replace(/\bis-pending\b/, '').trim()).toBe(className);
    fireEvent.click(saveBtn('api'));
    expect(sent(h)).toHaveLength(1); // a repeat while pending is dropped
  });

  it('a Save the host accepted drops the draft and reports it; a refusal keeps what was typed', () => {
    const h = mountOverlays(stateWith());
    open(h);
    type('api', 'A=1');
    fireEvent.click(saveBtn('api'));
    answer(h, sent(h)[0]![2], false);
    expect(area('api').value).toBe('A=1');
    expect(msg('api')).toBe('Unsaved changes');

    fireEvent.click(saveBtn('api'));
    answer(h, sent(h)[1]![2], true);
    expect(area('api').value).toBe('APP_HISTORY_FEATURE=true'); // what is STORED, now that the draft is gone
    expect(msg('api')).toBe('Saved — applies at the next start.');
  });

  it('ignores an answer to someone else’s request', () => {
    const h = mountOverlays(stateWith());
    open(h);
    type('api', 'A=1');
    answer(h, 'req-other', true);
    expect(area('api').value).toBe('A=1');
  });

  it('Close hides it and a reopen starts without the old drafts', () => {
    const h = mountOverlays(stateWith());
    open(h);
    type('api', 'A=1');
    fireEvent.click(must('[data-art="back"]'));
    expect(isHidden('#envView')).toBe(true);
    expect(bodyHas('env-nav')).toBe(false);
    expect(q('.envscope')).toBeNull();
    open(h);
    expect(area('api').value).toBe('APP_HISTORY_FEATURE=true');
  });
});

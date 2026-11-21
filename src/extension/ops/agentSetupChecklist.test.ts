import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAgentSetupChecklist, timeLabel, AGENT_SETUP_DEBOUNCE_MS } from './agentSetupChecklist.js';

const report = (status: 'todo' | 'done' = 'todo') =>
  JSON.stringify({ items: [{ code: 'a', title: 'A', required: true, status, tool: 't', section: 'general', detail: 'why' }] });

function setup(runImpl?: () => Promise<string>) {
  const run = vi.fn(runImpl ?? (async () => report()));
  const logError = vi.fn();
  const c = createAgentSetupChecklist({ run, now: () => new Date(2026, 0, 1, 9, 5), logError });
  return { c, run, logError };
}

describe('agent setup checklist', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('formats the time as HH:MM', () => {
    expect(timeLabel(new Date(2026, 0, 1, 9, 5))).toBe('09:05');
  });

  it('refresh runs the child once and exposes rows and the time', async () => {
    const { c, run } = setup();
    await c.refresh();
    expect(run).toHaveBeenCalledTimes(1);
    const v = c.view();
    expect(v.rows).toHaveLength(1);
    expect(v.updatedLabel).toBe('09:05');
    expect(v.checking).toBe(false);
  });

  it('shows checking over the old rows while a second run is in flight, and notifies at start and end', async () => {
    let release: (s: string) => void = () => undefined;
    const { c, run } = setup();
    await c.refresh();
    run.mockImplementationOnce(() => new Promise<string>((r) => (release = r)));
    const listener = vi.fn();
    c.subscribe(listener);
    const p = c.refresh();
    expect(c.view().checking).toBe(true);
    expect(c.view().rows).toHaveLength(1);
    expect(listener).toHaveBeenCalledTimes(1);
    release(report('done'));
    await p;
    expect(c.view().checking).toBe(false);
    expect(c.view().rows[0]?.status).toBe('done');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('joins a run in flight instead of starting a second child', async () => {
    const { c, run } = setup();
    await Promise.all([c.refresh(), c.refresh()]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a burst of schedule calls runs one check after the quiet window', async () => {
    const { c, run } = setup();
    c.schedule();
    await vi.advanceTimersByTimeAsync(AGENT_SETUP_DEBOUNCE_MS - 1);
    c.schedule(); // restarts the window
    await vi.advanceTimersByTimeAsync(AGENT_SETUP_DEBOUNCE_MS - 1);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(AGENT_SETUP_DEBOUNCE_MS * 3);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a change during a run triggers exactly one more run', async () => {
    let release: (s: string) => void = () => undefined;
    const { c, run } = setup(() => new Promise<string>((r) => (release = r)));
    const p = c.refresh();
    c.schedule();
    c.schedule();
    release(report());
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    release(report('done'));
    await p;
    expect(run).toHaveBeenCalledTimes(2);
    expect(c.view().rows[0]?.status).toBe('done');
  });

  it('(c) keeps the old rows and reports the reason when the child fails', async () => {
    const { c, run, logError } = setup();
    await c.refresh();
    run.mockRejectedValueOnce(new Error('timed out after 120 s'));
    await c.refresh();
    const v = c.view();
    expect(v.error).toBe('timed out after 120 s');
    expect(v.rows).toHaveLength(1);
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it('an unreadable report is an error, and a later good run clears it', async () => {
    const { c, run } = setup(async () => 'not json');
    await c.refresh();
    expect(c.view().error).toBe('setup checklist printed no JSON report');
    run.mockResolvedValueOnce(report());
    await c.refresh();
    expect(c.view().error).toBeNull();
  });

  it('unsubscribe stops notifications; dispose stops timers and runs', async () => {
    const { c, run } = setup();
    const l = vi.fn();
    const off = c.subscribe(l);
    off();
    await c.refresh();
    expect(l).not.toHaveBeenCalled();
    c.schedule();
    c.dispose();
    await vi.advanceTimersByTimeAsync(AGENT_SETUP_DEBOUNCE_MS * 2);
    expect(run).toHaveBeenCalledTimes(1);
    await c.refresh();
    expect(run).toHaveBeenCalledTimes(1);
    c.schedule();
    await vi.advanceTimersByTimeAsync(AGENT_SETUP_DEBOUNCE_MS * 2);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('logs the failure with its message and the cause', async () => {
    const { c, run, logError } = setup();
    const cause = new Error('boom');
    run.mockRejectedValueOnce(cause);
    await c.refresh();
    expect(logError).toHaveBeenCalledWith('karst: agent setup checklist failed', cause);
  });

  it('schedule after dispose arms no timer', () => {
    const { c } = setup();
    c.dispose();
    c.schedule();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('dispose clears a pending debounce timer', () => {
    const { c } = setup();
    c.schedule();
    expect(vi.getTimerCount()).toBe(1);
    c.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('dispose drops the listeners, so a run that ends later notifies nobody', async () => {
    let release: (s: string) => void = () => undefined;
    const { c } = setup(() => new Promise<string>((r) => (release = r)));
    const l = vi.fn();
    c.subscribe(l);
    const p = c.refresh();
    expect(l).toHaveBeenCalledTimes(1);
    c.dispose();
    release(report());
    await p;
    expect(l).toHaveBeenCalledTimes(1);
  });

  it('a change during a run does not rerun after the controller is disposed', async () => {
    let release: (s: string) => void = () => undefined;
    const { c, run } = setup(() => new Promise<string>((r) => (release = r)));
    const p = c.refresh();
    c.schedule();
    c.dispose();
    release(report());
    await p;
    expect(run).toHaveBeenCalledTimes(1);
  });
});

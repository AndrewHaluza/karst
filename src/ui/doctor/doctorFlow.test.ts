import { describe, expect, it } from 'vitest';
import { createDoctorFlow, createDoctorPanelController, type DoctorFlow, type DoctorFlowDeps, type DoctorPanelLifecycle } from './doctorFlow.js';
import type { DoctorCheck, DoctorReport } from '../../doctor/types.js';

const empty = (): DoctorReport => ({
  areas: ['tools', 'manifest', 'state', 'wiring'],
  fixRequested: false,
  checks: [],
  applied: [],
  summary: { ok: 0, warn: 0, fail: 0, skipped: 0 },
  exitCode: 0,
});

const pass = (id: string): DoctorCheck => ({ id, area: 'tools', status: 'ok', title: 'Git', detail: 'Git is installed.' });

const auto = (id: string, summary: string): DoctorCheck => ({
  id,
  area: 'state',
  status: 'warn',
  title: 'Leaked server',
  detail: `${summary}.`,
  fix: { tier: 'auto', summary, action: { kind: 'recreate-launcher' } },
});

const autoReport = (): DoctorReport => {
  const checks = [
    auto('state.server-leaked.4123', 'Kill leaked server process 4123'),
    auto('state.worktree-prune.7', 'Prune clean worktree /tmp/wt/api'),
    auto('state.server-dead.12', 'Mark server 12 stopped'),
  ];
  return { ...empty(), fixRequested: false, checks, summary: { ok: 0, warn: 3, fail: 0, skipped: 0 } };
};

const oneAuto = (): DoctorReport => {
  const checks = [auto('state.server-leaked.4123', 'Kill leaked server process 4123'), pass('tools.git')];
  return { ...empty(), checks, summary: { ok: 1, warn: 1, fail: 0, skipped: 0 } };
};

interface ConfirmCall {
  title: string;
  items: readonly string[];
  actionLabel: string;
}

interface RunCall {
  fix: boolean;
  only?: readonly string[];
}

function harness() {
  const renders: string[] = [];
  const posts: Array<{ type: 'fix-cancelled' } | { type: 'copy-done' }> = [];
  const copies: string[] = [];
  const confirms: ConfirmCall[] = [];
  const runs: RunCall[] = [];
  let answer = true;
  let confirmHeld: ((value: boolean) => void) | undefined;
  let holdConfirm = false;
  let failNext = false;
  let queue: DoctorReport[] = [empty()];

  const deps: DoctorFlowDeps = {
    run: async (fix, only) => {
      runs.push({ fix, ...(only === undefined ? {} : { only }) });
      if (failNext) {
        failNext = false;
        throw new Error('cli exploded');
      }
      return queue.length > 1 ? queue.shift()! : (queue[0] ?? empty());
    },
    confirm: async (title, items, actionLabel) => {
      confirms.push({ title, items: [...items], actionLabel });
      if (holdConfirm) {
        holdConfirm = false;
        return new Promise<boolean>((resolve) => {
          confirmHeld = resolve;
        });
      }
      return answer;
    },
    render: (html) => {
      renders.push(html);
    },
    post: (message) => {
      posts.push(message);
    },
    copy: (text) => {
      copies.push(text);
    },
    nonce: () => 'n',
    now: () => new Date(2026, 0, 1, 14, 2),
  };

  return {
    deps,
    renders,
    posts,
    copies,
    confirms,
    runs,
    setReports: (...reports: DoctorReport[]) => {
      queue = [...reports];
    },
    setAnswer: (value: boolean) => {
      answer = value;
    },
    holdNextConfirm: () => {
      holdConfirm = true;
    },
    releaseConfirm: (value: boolean) => {
      confirmHeld?.(value);
    },
    failNext: () => {
      failNext = true;
    },
    lastRender: () => renders[renders.length - 1] ?? '',
  };
}

describe('initial run (DR-4)', () => {
  it('renders the loading page, then the report, without asking for fixes', async () => {
    const h = harness();
    h.setReports({ ...empty(), checks: [pass('tools.git')], summary: { ok: 1, warn: 0, fail: 0, skipped: 0 } });
    const flow = createDoctorFlow(h.deps);
    await flow.start();
    expect(h.renders).toHaveLength(2);
    expect(h.renders[0]).toContain('Running checks…');
    expect(h.renders[1]).toContain('Checked at 14:02');
    expect(h.runs).toEqual([{ fix: false }]);
  });

  it('turns a failed run into the error page, and Run again recovers', async () => {
    const h = harness();
    h.setReports({ ...empty(), checks: [pass('tools.git')], summary: { ok: 1, warn: 0, fail: 0, skipped: 0 } });
    const flow = createDoctorFlow(h.deps);
    h.failNext();
    await flow.start();
    expect(h.lastRender()).toContain('Karst could not run the checks: cli exploded.');
    // running cleared: the retry is not swallowed by the busy guard
    await flow.handleMessage({ type: 'rerun' });
    expect(h.lastRender()).toContain('class="k-pagehead"');
    expect(h.lastRender()).not.toContain('could not run the checks');
  });
});

describe('rerun', () => {
  it('shows the loading page and returns focus to the page title', async () => {
    const h = harness();
    const flow = createDoctorFlow(h.deps);
    await flow.start();
    h.renders.length = 0;
    await flow.handleMessage({ type: 'rerun' });
    expect(h.renders[0]).toContain('Running checks…');
    expect(h.renders[1]).toContain("document.querySelector('.k-pagehead-title')?.focus()");
  });

  it('ignores an unknown message', async () => {
    const h = harness();
    const flow = createDoctorFlow(h.deps);
    await flow.start();
    h.renders.length = 0;
    await flow.handleMessage({ type: 'nope' });
    await flow.handleMessage(null);
    expect(h.renders).toHaveLength(0);
  });
});

describe('the fix confirmation (DR-3, UI-R33)', () => {
  it('lists every auto fix in a host modal with plural wording', async () => {
    const h = harness();
    h.setReports(autoReport(), autoReport());
    const flow = createDoctorFlow(h.deps);
    await flow.start();
    h.setAnswer(true);
    await flow.handleMessage({ type: 'fix' });
    expect(h.confirms).toEqual([
      {
        title: 'Apply 3 safe fixes?',
        items: ['Kill leaked server process 4123', 'Prune clean worktree /tmp/wt/api', 'Mark server 12 stopped'],
        actionLabel: 'Apply 3 fixes',
      },
    ]);
  });

  it('uses the singular wording for one fix', async () => {
    const h = harness();
    h.setReports(oneAuto(), oneAuto());
    const flow = createDoctorFlow(h.deps);
    await flow.start();
    await flow.handleMessage({ type: 'fix' });
    expect(h.confirms[0]).toEqual({
      title: 'Apply 1 safe fix?',
      items: ['Kill leaked server process 4123'],
      actionLabel: 'Apply 1 fix',
    });
  });

  it('runs nothing and answers fix-cancelled when the user cancels', async () => {
    const h = harness();
    h.setReports(autoReport(), autoReport());
    const flow = createDoctorFlow(h.deps);
    await flow.start();
    h.setAnswer(false);
    await flow.handleMessage({ type: 'fix' });
    expect(h.runs.filter((r) => r.fix)).toHaveLength(0);
    expect(h.posts).toEqual([{ type: 'fix-cancelled' }]);
  });

  it('hands the button back when the confirmation itself fails', async () => {
    const h = harness();
    h.setReports(autoReport());
    const flow = createDoctorFlow({
      ...h.deps,
      confirm: async () => {
        throw new Error('the modal could not be shown');
      },
    });
    await flow.start();
    await flow.handleMessage({ type: 'fix' });
    // A rejected modal is a cancel: the page must not stay disabled and aria-busy.
    expect(h.posts).toEqual([{ type: 'fix-cancelled' }]);
    expect(h.runs.filter((r) => r.fix)).toHaveLength(0);
  });

  it('opens the modal again after a cancel', async () => {
    const h = harness();
    h.setReports(autoReport(), autoReport(), autoReport());
    const flow = createDoctorFlow(h.deps);
    await flow.start();
    h.setAnswer(false);
    await flow.handleMessage({ type: 'fix' });
    h.setAnswer(true);
    await flow.handleMessage({ type: 'fix' });
    expect(h.confirms).toHaveLength(2);
    expect(h.runs.filter((r) => r.fix)).toHaveLength(1);
  });

  it('applies exactly the ids the modal listed, after a loading page', async () => {
    const h = harness();
    h.setReports(autoReport(), { ...autoReport(), fixRequested: true, applied: [] });
    const flow = createDoctorFlow(h.deps);
    await flow.start();
    h.renders.length = 0;
    await flow.handleMessage({ type: 'fix' });
    expect(h.runs.filter((r) => r.fix)).toEqual([
      { fix: true, only: ['state.server-leaked.4123', 'state.worktree-prune.7', 'state.server-dead.12'] },
    ]);
    expect(h.renders[0]).toContain('Running checks…');
    expect(h.renders[1]).toContain('Fix safe issues (3)');
  });

  it('answers fix-cancelled without a modal when there is nothing to fix', async () => {
    const h = harness();
    h.setReports({ ...empty(), checks: [pass('tools.git')], summary: { ok: 1, warn: 0, fail: 0, skipped: 0 } });
    const flow = createDoctorFlow(h.deps);
    await flow.start();
    await flow.handleMessage({ type: 'fix' });
    expect(h.confirms).toHaveLength(0);
    expect(h.posts).toEqual([{ type: 'fix-cancelled' }]);
  });

  it('renders the error page when the fix run fails', async () => {
    const h = harness();
    h.setReports(autoReport());
    const flow = createDoctorFlow(h.deps);
    await flow.start();
    h.failNext();
    await flow.handleMessage({ type: 'fix' });
    expect(h.lastRender()).toContain('Karst could not run the checks: cli exploded.');
  });
});

describe('the busy guard (DR-5)', () => {
  it('starts one modal and one run for two concurrent fix messages', async () => {
    const h = harness();
    h.setReports(autoReport(), autoReport());
    const flow = createDoctorFlow(h.deps);
    await flow.start();
    h.holdNextConfirm();
    const first = flow.handleMessage({ type: 'fix' });
    await Promise.resolve();
    await flow.handleMessage({ type: 'fix' });
    expect(h.confirms).toHaveLength(1);
    h.releaseConfirm(true);
    await first;
    expect(h.runs.filter((r) => r.fix)).toHaveLength(1);
  });

  it('ignores a rerun while a fix is waiting on the modal', async () => {
    const h = harness();
    h.setReports(autoReport(), autoReport());
    const flow = createDoctorFlow(h.deps);
    await flow.start();
    h.holdNextConfirm();
    const first = flow.handleMessage({ type: 'fix' });
    await Promise.resolve();
    const before = h.renders.length;
    await flow.handleMessage({ type: 'rerun' });
    expect(h.renders).toHaveLength(before);
    h.releaseConfirm(false);
    await first;
  });
});

describe('copy (DR-2)', () => {
  it('forwards the copied command to the clipboard seam', async () => {
    const h = harness();
    const flow = createDoctorFlow(h.deps);
    await flow.handleMessage({ type: 'copy', text: 'sbx prune --all' });
    expect(h.copies).toEqual(['sbx prune --all']);
  });

  it('confirms a successful copy so the page can announce it (UI-R27)', async () => {
    const h = harness();
    const flow = createDoctorFlow(h.deps);
    await flow.handleMessage({ type: 'copy', text: 'sbx prune --all' });
    expect(h.posts).toEqual([{ type: 'copy-done' }]);
  });

  it('ignores a copy message with no text', async () => {
    const h = harness();
    const flow = createDoctorFlow(h.deps);
    await flow.handleMessage({ type: 'copy', text: 42 });
    expect(h.copies).toHaveLength(0);
    expect(h.posts).toHaveLength(0);
  });
});

describe('a panel that closes mid-run (DR-7)', () => {
  it('drops the report when the run finishes after the dispose', async () => {
    let closed = false;
    let settle!: (r: DoctorReport) => void;
    const renders: string[] = [];
    const flow = createDoctorFlow({
      run: () => new Promise<DoctorReport>((resolve) => {
        settle = resolve;
      }),
      confirm: async () => true,
      render: (html) => renders.push(html),
      post: () => {
        throw new Error('post reached a disposed panel');
      },
      isDisposed: () => closed,
      nonce: () => 'n',
    });
    const started = flow.start();
    closed = true;
    settle(empty());
    await started;
    // Only the loading page, written while the tab was still open.
    expect(renders).toHaveLength(1);
    expect(renders[0]).toContain('Running checks…');
  });

  it('drops the error page too: the catch cannot render a second time into a closed panel', async () => {
    let closed = false;
    let fail!: (e: Error) => void;
    const renders: string[] = [];
    const flow = createDoctorFlow({
      run: () => new Promise<DoctorReport>((_resolve, reject) => {
        fail = reject;
      }),
      confirm: async () => true,
      render: (html) => renders.push(html),
      post: () => undefined,
      isDisposed: () => closed,
      nonce: () => 'n',
    });
    const started = flow.start();
    closed = true;
    fail(new Error('boom'));
    await started;
    expect(renders).toHaveLength(1);
  });

  it('runs nothing when the panel closes while the confirmation is open', async () => {
    let closed = false;
    const runs: RunCall[] = [];
    const posts: Array<{ type: string }> = [];
    const flow = createDoctorFlow({
      run: async (fix, only) => {
        runs.push({ fix, ...(only === undefined ? {} : { only }) });
        return autoReport();
      },
      confirm: async () => {
        closed = true;
        return true;
      },
      render: () => undefined,
      post: (message) => posts.push(message),
      isDisposed: () => closed,
      nonce: () => 'n',
    });
    await flow.start();
    await flow.handleMessage({ type: 'fix' });
    expect(runs.filter((r) => r.fix)).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });
});

interface FakePanel {
  readonly webview: { html: string; onDidReceiveMessage(fn: (m: unknown) => void): { dispose(): void } };
  onDidDispose(fn: () => void): { dispose(): void };
  reveal(): void;
  dispose(): void;
  readonly revealCalls: number;
  readonly disposeCalls: number;
  readonly html: string;
  fireMessage(message: unknown): void;
}

function fakePanel(): FakePanel {
  let html = '';
  let messageListener: ((m: unknown) => void) | undefined;
  let disposeListener: (() => void) | undefined;
  let revealCalls = 0;
  let disposeCalls = 0;
  return {
    get webview() {
      return {
        get html() {
          return html;
        },
        set html(value: string) {
          html = value;
        },
        onDidReceiveMessage(fn: (m: unknown) => void) {
          messageListener = fn;
          return { dispose() {} };
        },
      };
    },
    onDidDispose(fn: () => void) {
      disposeListener = fn;
      return { dispose() {} };
    },
    reveal() {
      revealCalls += 1;
    },
    dispose() {
      disposeCalls += 1;
      disposeListener?.();
    },
    get revealCalls() {
      return revealCalls;
    },
    get disposeCalls() {
      return disposeCalls;
    },
    get html() {
      return html;
    },
    fireMessage(message: unknown) {
      messageListener?.(message);
    },
  };
}

interface FakeFlow extends DoctorFlow {
  readonly starts: number;
  readonly messages: unknown[];
}

function fakeFlow(): FakeFlow {
  let starts = 0;
  const messages: unknown[] = [];
  return {
    start: async () => {
      starts += 1;
    },
    handleMessage: async (message: unknown) => {
      messages.push(message);
    },
    get starts() {
      return starts;
    },
    get messages() {
      return messages;
    },
  };
}

describe('single-panel reuse (DR-7)', () => {
  function controllerHarness() {
    const panels: FakePanel[] = [];
    const flows: FakeFlow[] = [];
    const adopted: FakePanel[] = [];
    const lifecycles: DoctorPanelLifecycle[] = [];
    const controller = createDoctorPanelController<FakePanel>({
      createPanel: () => {
        const panel = fakePanel();
        panels.push(panel);
        return panel;
      },
      adopt: (panel) => {
        adopted.push(panel);
      },
      createFlow: (_panel, lifecycle) => {
        lifecycles.push(lifecycle);
        const flow = fakeFlow();
        flows.push(flow);
        return flow;
      },
    });
    return { controller, panels, flows, adopted, lifecycles };
  }

  it('reveals the open panel and asks it to rerun instead of minting a second one', async () => {
    const h = controllerHarness();
    await h.controller.open();
    await h.controller.open();
    expect(h.panels).toHaveLength(1);
    expect(h.panels[0]!.revealCalls).toBe(1);
    expect(h.flows[0]!.messages).toEqual([{ type: 'rerun' }]);
    expect(h.flows[0]!.starts).toBe(1);
  });

  it('creates a new panel after the current one is disposed', async () => {
    const h = controllerHarness();
    await h.controller.open();
    h.panels[0]!.dispose();
    await h.controller.open();
    expect(h.panels).toHaveLength(2);
    expect(h.flows[1]!.starts).toBe(1);
  });

  it('adopts the created panel (icon + scripts before the flow starts)', async () => {
    const h = controllerHarness();
    await h.controller.open();
    expect(h.adopted).toEqual([h.panels[0]]);
  });

  it('adopts a restored panel too: a restored tab comes back with scripts off', async () => {
    const h = controllerHarness();
    const restored = fakePanel();
    await h.controller.restore(restored);
    expect(h.adopted).toEqual([restored]);
  });

  it('tells the flow its panel is disposed, so a late run drops its render', async () => {
    const h = controllerHarness();
    await h.controller.open();
    expect(h.lifecycles[0]!.isDisposed()).toBe(false);
    h.panels[0]!.dispose();
    expect(h.lifecycles[0]!.isDisposed()).toBe(true);
  });

  it('adopts a restored panel and wires its messages', async () => {
    const h = controllerHarness();
    const restored = fakePanel();
    await h.controller.restore(restored);
    expect(h.flows[0]!.starts).toBe(1);
    restored.fireMessage({ type: 'fix' });
    await Promise.resolve();
    expect(h.flows[0]!.messages).toEqual([{ type: 'fix' }]);
  });

  it('does not let a rejected message handler escape as an unhandled rejection', async () => {
    const panels: FakePanel[] = [];
    const controller = createDoctorPanelController<FakePanel>({
      createPanel: () => {
        const panel = fakePanel();
        panels.push(panel);
        return panel;
      },
      adopt: () => undefined,
      createFlow: () => ({
        start: async () => undefined,
        handleMessage: async () => {
          throw new Error('handler exploded');
        },
      }),
    });
    await controller.open();
    panels[0]!.fireMessage({ type: 'rerun' });
    await Promise.resolve();
    await Promise.resolve();
  });

  it('disposes a duplicate restored panel when one is already open', async () => {
    const h = controllerHarness();
    await h.controller.open();
    const duplicate = fakePanel();
    await h.controller.restore(duplicate);
    expect(duplicate.disposeCalls).toBe(1);
    expect(h.panels).toHaveLength(1);
  });
});

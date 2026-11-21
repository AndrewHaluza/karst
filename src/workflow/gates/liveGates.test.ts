import { describe, expect, it } from 'vitest';
import { gateWaitLive, LiveGateRegistry } from './liveGates.js';

describe('LiveGateRegistry', () => {
  const clock = (): (() => string) => {
    let n = 0;
    return () => `t${++n}`;
  };

  it('has no snapshot when no gate is in flight', () => {
    expect(new LiveGateRegistry().snapshot(1, 'uat')).toBeUndefined();
  });

  it('keeps one state per gate, per ticket and stage', () => {
    const r = new LiveGateRegistry(clock());
    r.wait(1, 'uat', 'lint', { kind: 'gate', held: 1, limit: 1 });
    r.start(1, 'uat', 'build');
    r.start(2, 'uat', 'other');
    expect(r.snapshot(1, 'uat')).toEqual({ lint: { kind: 'wait', wait: { kind: 'gate', held: 1, limit: 1 } }, build: { kind: 'run' } });
    expect(r.snapshot(1, 'review')).toBeUndefined();
  });

  it('stamps the instant the slot is taken, and a repeat start keeps it', () => {
    const r = new LiveGateRegistry(clock());
    r.wait(1, 'uat', 'lint', { kind: 'port' });
    r.start(1, 'uat', 'lint');
    r.start(1, 'uat', 'lint');
    expect(r.snapshot(1, 'uat')).toEqual({ lint: { kind: 'run', since: 't1' } });
  });

  it('a gate that did not wait carries no instant', () => {
    const r = new LiveGateRegistry(clock());
    r.start(1, 'uat', 'lint');
    expect(r.snapshot(1, 'uat')).toEqual({ lint: { kind: 'run' } });
  });

  it('end removes one gate, clear removes a stage or the whole ticket', () => {
    const r = new LiveGateRegistry();
    r.start(1, 'uat', 'a');
    r.start(1, 'uat', 'b');
    r.start(1, 'review', 'c');
    r.end(1, 'uat', 'a');
    expect(Object.keys(r.snapshot(1, 'uat') ?? {})).toEqual(['b']);
    r.end(1, 'uat', 'b');
    expect(r.snapshot(1, 'uat')).toBeUndefined();
    r.clear(1, 'review');
    expect(r.snapshot(1, 'review')).toBeUndefined();
    r.start(1, 'uat', 'a');
    r.start(1, 'review', 'c');
    r.start(2, 'uat', 'z');
    r.clear(1);
    expect(r.snapshot(1, 'uat')).toBeUndefined();
    expect(r.snapshot(1, 'review')).toBeUndefined();
    expect(r.snapshot(2, 'uat')).toBeDefined();
  });

  it('a bound sink writes its ticket and stage and calls onChange after each change', () => {
    const r = new LiveGateRegistry(clock());
    let calls = 0;
    const sink = r.sinkFor(3, 'ship', () => calls++);
    sink.wait('lint', { kind: 'port' });
    expect(r.snapshot(3, 'ship')).toEqual({ lint: { kind: 'wait', wait: { kind: 'port' } } });
    sink.start('lint');
    expect(r.snapshot(3, 'ship')).toEqual({ lint: { kind: 'run', since: 't1' } });
    sink.end('lint');
    expect(r.snapshot(3, 'ship')).toBeUndefined();
    expect(calls).toBe(3);
  });

  it('words the header overlay of a waiting gate', () => {
    expect(gateWaitLive('lint', { kind: 'port' })).toEqual({ status: 'wait', label: 'lint', detail: 'waiting for a port slot' });
  });
});

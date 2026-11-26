import { describe, expect, it } from 'vitest';
import {
  WINDOW_SSH_GATE_REGISTRY,
  createSshGateRegistry,
  sshGateKey,
} from './sshGateRegistry.js';

describe('sshGateKey', () => {
  it('is <remote>/<name>', () => {
    expect(sshGateKey('devbox', 'karst-0a1b2c3d-7-claude')).toBe('devbox/karst-0a1b2c3d-7-claude');
  });
});

describe('createSshGateRegistry', () => {
  it('tracks the live run ids per sandbox key', () => {
    const registry = createSshGateRegistry();
    const key = sshGateKey('devbox', 'karst-0a1b2c3d-7-claude');
    expect(registry.live(key).size).toBe(0);
    registry.add(key, 'a');
    registry.add(key, 'b');
    expect([...registry.live(key)].sort()).toEqual(['a', 'b']);
  });

  it('keys are independent', () => {
    const registry = createSshGateRegistry();
    registry.add('devbox/one', 'a');
    registry.add('devbox/two', 'b');
    expect([...registry.live('devbox/one')]).toEqual(['a']);
    expect([...registry.live('devbox/two')]).toEqual(['b']);
  });

  it('remove forgets one run id and nothing else', () => {
    const registry = createSshGateRegistry();
    registry.add('k', 'a');
    registry.add('k', 'b');
    registry.remove('k', 'a');
    expect([...registry.live('k')]).toEqual(['b']);
    registry.remove('k', 'missing');
    expect([...registry.live('k')]).toEqual(['b']);
    registry.remove('k', 'b');
    expect(registry.live('k').size).toBe(0);
  });

  it('reports an unknown key as empty rather than throwing', () => {
    const registry = createSshGateRegistry();
    expect(registry.live('nope/none').size).toBe(0);
    expect(() => registry.remove('nope/none', 'a')).not.toThrow();
  });

  it('live() is a snapshot: mutating it never changes the registry', () => {
    const registry = createSshGateRegistry();
    registry.add('k', 'a');
    const live = registry.live('k') as Set<string>;
    live.add('injected');
    live.delete('a');
    expect([...registry.live('k')]).toEqual(['a']);
  });

  it('two registries do not share state', () => {
    const one = createSshGateRegistry();
    const two = createSshGateRegistry();
    one.add('k', 'a');
    expect(two.live('k').size).toBe(0);
  });

  it('the window registry is one shared instance', () => {
    expect(WINDOW_SSH_GATE_REGISTRY).toBe(WINDOW_SSH_GATE_REGISTRY);
    expect(typeof WINDOW_SSH_GATE_REGISTRY.add).toBe('function');
  });
});

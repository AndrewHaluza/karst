import { describe, expect, it } from 'vitest';
import { FakeAdapter } from './fakeCore.js';

describe('FakeAdapter', () => {
  it('answers headless runs deterministically with no usage', async () => {
    const a = new FakeAdapter();
    const r1 = await a.runHeadless({ prompt: 'x', cwd: '/tmp' });
    const r2 = await a.runHeadless({ prompt: 'y', cwd: '/tmp' });
    expect(r1).toEqual(r2);
    expect(r1.sessionId).toBe('fake-session');
    expect(r1.verdict).toBeNull();
    expect(r1.usage).toBeUndefined();
  });

  it('builds an inert interactive command', () => {
    const cmd = new FakeAdapter().buildInteractiveCommand();
    expect(cmd.command).toBe('node');
    expect(cmd.env).toEqual({});
  });

  it('declares no lifecycle or resume support', () => {
    expect(new FakeAdapter().capabilities).toEqual({ lifecycleEvents: false, resume: false });
  });
});

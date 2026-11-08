import { describe, expect, it } from 'vitest';
import { GUEST_MEMORY_MARKER, guestMemoryScript } from './sbxGuestMemory.js';

describe('guestMemoryScript', () => {
  const script = guestMemoryScript();

  it('starts with the marker', () => {
    expect(script.split('\n')[0]).toBe(GUEST_MEMORY_MARKER);
  });

  it('exits early when the loop already runs', () => {
    expect(script).toContain('kill -0 "$(cat /run/karst-reclaim.pid)" 2>/dev/null; then exit 0; fi');
  });

  it('the loop uses the constants', () => {
    expect(script).toContain('while sleep 60; do');
    expect(script).toContain('l < 0.30');
    expect(script).toContain('-gt 262144');
    expect(script).toContain('sync; echo 1 > /proc/sys/vm/drop_caches');
  });

  it('the loop is detached from the exec', () => {
    expect(script).toContain('nohup sh /run/karst-reclaim.sh </dev/null >/dev/null 2>&1 &');
  });

  it('the heredoc is quoted', () => {
    expect(script).toContain("<<'KARST_RECLAIM'");
    expect(script).toContain('${c:-0}');
  });

  it('has no swap and no other drop level', () => {
    for (const bad of ['swapon', 'mkswap', 'fallocate', 'zram', 'echo 2 > /proc/sys/vm/drop_caches', 'echo 3 > /proc/sys/vm/drop_caches']) expect(script).not.toContain(bad);
  });
});

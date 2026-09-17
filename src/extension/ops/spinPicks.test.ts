import { describe, it, expect } from 'vitest';
import { spinRepoPicks, servicesOnlyArg } from './spinPicks.js';
import type { Manifest } from '../../manifest/types.js';

const manifest = {
  repositories: {
    api: { path: '/api', service: { start: 'npm start', ports: [3000] } },
    docs: { path: '/docs' },
  },
} as unknown as Manifest;

describe('spinRepoPicks', () => {
  it('offers every repository, marking the ones with no service', () => {
    expect(spinRepoPicks(manifest, undefined, {})).toEqual([
      { label: 'api', description: undefined, picked: true },
      { label: 'docs', description: 'no service — worktree only', picked: true },
    ]);
  });

  it('omits repositories with no service when only services are being started', () => {
    expect(spinRepoPicks(manifest, undefined, { servicesOnly: true })).toEqual([
      { label: 'api', description: undefined, picked: true },
    ]);
  });

  it('pre-picks the remembered selection only', () => {
    const picks = spinRepoPicks(manifest, ['docs'], {});
    expect(picks.map((p) => p.picked)).toEqual([false, true]);
  });
});

describe('servicesOnlyArg', () => {
  it('reads the flag off an object arg and defaults to false', () => {
    expect(servicesOnlyArg({ ticketId: 1, servicesOnly: true })).toBe(true);
    expect(servicesOnlyArg({ ticketId: 1 })).toBe(false);
    expect(servicesOnlyArg(1)).toBe(false);
  });
});

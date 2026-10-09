import { describe, it, expect } from 'vitest';
import { spinRepoPicks, servicesOnlyArg } from './spinPicks.js';
import type { Manifest } from '../../manifest/types.js';

const manifest = {
  repositories: {
    api: { path: '/api', service: { start: 'npm start', ports: [3000] } },
    docs: { path: '/docs' },
    web: {
      path: '/web',
      services: {
        front: { start: 'npm run front', ports: [3001] },
        back: { start: 'npm run back', ports: [3002] },
      },
    },
  },
} as unknown as Manifest;

describe('spinRepoPicks', () => {
  it('offers every repository, marking the ones with no service', () => {
    expect(spinRepoPicks(manifest, undefined, {})).toEqual([
      { label: 'api', description: undefined, picked: true },
      { label: 'docs', description: 'no service — worktree only', picked: true },
      { label: 'web', description: undefined, picked: true },
    ]);
  });

  it('omits repositories with no service when only services are being started', () => {
    expect(spinRepoPicks(manifest, undefined, { servicesOnly: true })).toEqual([
      { label: 'api', description: undefined, picked: true },
      { label: 'web', description: undefined, picked: true },
    ]);
  });

  it('offers a multi-service repository as runnable, not as worktree-only', () => {
    const web = spinRepoPicks(manifest, undefined, {}).find((p) => p.label === 'web');
    expect(web).toEqual({ label: 'web', description: undefined, picked: true });
  });

  it('pre-picks the remembered selection only', () => {
    const picks = spinRepoPicks(manifest, ['docs'], {});
    expect(picks.map((p) => p.picked)).toEqual([false, true, false]);
  });
});

describe('servicesOnlyArg', () => {
  it('reads the flag off an object arg and defaults to false', () => {
    expect(servicesOnlyArg({ ticketId: 1, servicesOnly: true })).toBe(true);
    expect(servicesOnlyArg({ ticketId: 1 })).toBe(false);
    expect(servicesOnlyArg(1)).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { buildSetupStatus, AGENT_AUTH_REMINDER } from './status.js';
import { dependencyRegistry, agentDependency, GH_DEPENDENCY } from '../runtime/deps.js';

/** Probe fake: everything present except the named binaries. */
const absent =
  (...bins: string[]) =>
  (bin: string) =>
    !bins.includes(bin);

describe('buildSetupStatus', () => {
  it('marks all items done when every binary probes present', () => {
    const items = buildSetupStatus({ manifestExists: true, provider: 'claude', probe: () => true, ready: () => true });
    expect(items.every((i) => i.done)).toBe(true);
  });

  // The checklist is the registry, not a hand-maintained copy of it. Adding a
  // dependency must never need an edit here.
  it('lists the manifest plus every registry entry, keyed by binary', () => {
    const items = buildSetupStatus({ manifestExists: true, provider: 'claude', probe: () => true, ready: () => true });
    expect(items.map((i) => i.id)).toEqual([
      'manifest',
      ...dependencyRegistry('claude').map((d) => d.binary),
    ]);
  });

  // The old shape took a precomputed missing list, so an item whose binary the
  // caller forgot to probe silently claimed to be installed. Probing here makes
  // that unrepresentable: done comes from this item's own binary.
  it('reports an absent binary as undone even though nothing else is missing', () => {
    const items = buildSetupStatus({
      manifestExists: true,
      provider: 'claude',
      probe: absent('npm'),
      ready: () => true,
    });
    const npm = items.find((i) => i.id === 'npm')!;
    expect(npm.done).toBe(false);
    expect(items.filter((i) => !i.done)).toEqual([npm]);
  });

  it('marks the GitHub CLI undone when gh is absent, and says how to install it', () => {
    const items = buildSetupStatus({ manifestExists: true, provider: 'claude', probe: absent('gh'), ready: () => true });
    const gh = items.find((i) => i.id === 'gh')!;
    expect(gh.done).toBe(false);
    expect(gh.detail).toBe(GH_DEPENDENCY.install);
  });

  it('marks the manifest item undone when the manifest is missing', () => {
    const items = buildSetupStatus({ manifestExists: false, provider: 'claude', probe: () => true, ready: () => true });
    expect(items.find((i) => i.id === 'manifest')!.done).toBe(false);
  });

  it('marks git undone when git is absent', () => {
    const items = buildSetupStatus({
      manifestExists: true,
      provider: 'claude',
      probe: absent('git'),
      ready: () => true,
    });
    const git = items.find((i) => i.id === 'git')!;
    expect(git.done).toBe(false);
  });

  it('resolves the agent item from the provider', () => {
    const items = buildSetupStatus({ manifestExists: true, provider: 'codex', probe: () => true, ready: () => true });
    expect(items.map((i) => i.id)).toContain('codex');
  });

  it('carries install detail plus the auth reminder when the agent CLI is absent', () => {
    const dep = agentDependency('claude');
    const items = buildSetupStatus({
      manifestExists: true,
      provider: 'claude',
      probe: absent('claude'),
      ready: () => true,
    });
    const cli = items.find((i) => i.id === 'claude')!;
    expect(cli.done).toBe(false);
    expect(cli.detail).toContain(dep.install);
    expect(cli.detail).toContain(AGENT_AUTH_REMINDER);
  });

  // karst cannot check whether the agent CLI is logged in — no probe it declares
  // answers that — so the reminder stands in for the check it cannot run.
  it('keeps the auth reminder on the agent item even when it is done', () => {
    const items = buildSetupStatus({ manifestExists: true, provider: 'claude', probe: () => true, ready: () => true });
    const cli = items.find((i) => i.id === 'claude')!;
    expect(cli.done).toBe(true);
    expect(cli.detail).toBe(AGENT_AUTH_REMINDER);
  });

  // gh IS checkable, so the checklist checks it. An installed-but-logged-out gh
  // ships exactly as badly as an absent one; a row saying "installed" would be
  // true and useless.
  it('reports an installed but not-ready tool as undone, and says what to do', () => {
    const items = buildSetupStatus({
      manifestExists: true,
      provider: 'claude',
      probe: () => true,
      ready: () => false,
    });
    const gh = items.find((i) => i.id === 'gh')!;
    expect(gh.done).toBe(false);
    expect(gh.detail).toContain("gh auth login");
  });

  it('does not ask a missing tool whether it is ready', () => {
    let probed = false;
    buildSetupStatus({
      manifestExists: true,
      provider: 'claude',
      probe: () => false,
      ready: () => {
        probed = true;
        return true;
      },
    });
    expect(probed).toBe(false);
  });

  it('probes each binary once', () => {
    const seen: string[] = [];
    buildSetupStatus({
      manifestExists: true,
      provider: 'claude',
      ready: () => true,
      probe: (bin) => {
        seen.push(bin);
        return true;
      },
    });
    expect(seen).toEqual(['git', 'npm', 'gh', 'claude']);
  });
});

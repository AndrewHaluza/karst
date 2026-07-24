import { describe, it, expect } from 'vitest';
import {
  checkDependencyFaults,
  dependencyRegistry,
  dependencyState,
  ensureCapability,
  renderDependencyFault,
  renderMissingDependency,
  requiredFor,
  GIT_DEPENDENCY,
  GH_DEPENDENCY,
  NPM_DEPENDENCY,
  agentDependency,
  AGENT_CLI_DEPENDENCIES,
} from './deps.js';
import { resolveAdapter } from '../agent/registry.js';

describe('GH_DEPENDENCY', () => {
  // Ship shells out to `gh`. Without this, a missing gh stayed invisible until the
  // last stage of the workflow — the ticket failed to ship hours after the only
  // moment the user could cheaply have fixed it.
  it('probes the binary ship actually spawns, and says where to get it', () => {
    expect(GH_DEPENDENCY.binary).toBe('gh');
    expect(GH_DEPENDENCY.install).toContain('https://cli.github.com');
  });
});

describe('agentDependency', () => {
  it('returns the confirmed claude entry', () => {
    const dep = agentDependency('claude');
    expect(dep.binary).toBe('claude');
    expect(dep.label).toBe('the Claude Code CLI');
    expect(dep.install).toMatch(/claude\.com\/claude-code/);
    expect(AGENT_CLI_DEPENDENCIES.claude).toEqual(dep);
  });

  it('returns the confirmed antigravity entry', () => {
    const dep = agentDependency('antigravity');
    expect(dep.binary).toBe('agy');
    expect(dep.label).toBe('the Antigravity CLI (agy)');
    expect(dep.install).toMatch(/Antigravity CLI/);
    expect(AGENT_CLI_DEPENDENCIES.antigravity).toEqual(dep);
  });

  it('falls back to a generic entry for a provider without confirmed docs', () => {
    const dep = agentDependency('codex');
    expect(dep.binary).toBe('codex');
    expect(dep.label).toBe('the OpenAI Codex CLI');
    expect(dep.install).toMatch(/openai\.com|developers\.openai\.com/);
    expect(AGENT_CLI_DEPENDENCIES.codex).toEqual(dep);
  });

  // Guard against binary-name drift: the dependency check must probe the SAME
  // binary the launcher spawns, else the checklist reports a false present/missing.
  it('probes the same binary the claude adapter launches', () => {
    expect(agentDependency('claude').binary).toBe(resolveAdapter('claude').requiredBinary);
  });

  it('probes the same binary the antigravity adapter launches', () => {
    expect(agentDependency('antigravity').binary).toBe(resolveAdapter('antigravity').requiredBinary);
  });
});

describe('dependencyRegistry', () => {
  // One list, every surface derives from it. Adding gh previously took five edits
  // across three files; a forgotten one produced a checklist that lied.
  it('declares every binary karst itself spawns', () => {
    const bins = dependencyRegistry('claude').map((d) => d.binary);
    expect(bins).toEqual(['git', 'npm', 'gh', 'claude']);
  });

  it('resolves the agent entry from the provider', () => {
    expect(dependencyRegistry('codex').map((d) => d.binary)).toContain('codex');
  });

  it('gives every entry a capability, so no dependency can exist without a reason', () => {
    for (const dep of dependencyRegistry('claude')) {
      expect(dep.enables, dep.binary).toBeTruthy();
    }
  });
});

describe('requiredFor', () => {
  it('returns only the dependencies a capability needs', () => {
    expect(requiredFor('ship', dependencyRegistry('claude'))).toEqual([GH_DEPENDENCY]);
    expect(requiredFor('gates', dependencyRegistry('claude'))).toEqual([NPM_DEPENDENCY]);
  });
});

describe('NPM_DEPENDENCY', () => {
  // npm runs the worktree install and both gates. It was never checked — the same
  // latent bug gh had, and a missing npm reads as a FAILING gate, which parks the
  // ticket in an unwinnable fix loop.
  it('probes npm and enables the gates', () => {
    expect(NPM_DEPENDENCY.binary).toBe('npm');
    expect(NPM_DEPENDENCY.enables).toBe('gates');
  });
});

describe('dependencyState', () => {
  const yes = () => true;
  const no = () => false;

  it('is ok when the tool is installed and its readiness check succeeds', () => {
    expect(dependencyState(GH_DEPENDENCY, yes, yes)).toBe('ok');
  });

  it('is missing when the binary is absent — and never probes readiness', () => {
    let probed = false;
    const ready = () => {
      probed = true;
      return true;
    };
    expect(dependencyState(GH_DEPENDENCY, no, ready)).toBe('missing');
    // `gh auth status` on a machine without gh answers nothing and costs a spawn.
    expect(probed).toBe(false);
  });

  // Installed != usable. gh present but logged out fails ship exactly like gh
  // absent, six stages after the user could cheaply have fixed it.
  it('is not-ready when the tool is installed but its readiness check fails', () => {
    expect(dependencyState(GH_DEPENDENCY, yes, no)).toBe('not-ready');
  });

  it('is ok for a tool that declares no readiness check, whatever the probe says', () => {
    // git is either installed or not; there is nothing to be logged in to.
    expect(GIT_DEPENDENCY.ready).toBeUndefined();
    expect(dependencyState(GIT_DEPENDENCY, yes, no)).toBe('ok');
  });
});

describe('renderDependencyFault', () => {
  it('renders a missing tool as install guidance', () => {
    expect(renderDependencyFault(GH_DEPENDENCY, 'missing')).toBe(
      renderMissingDependency(GH_DEPENDENCY),
    );
  });

  it('renders a not-ready tool as a sign-in step, not an install step', () => {
    const msg = renderDependencyFault(GH_DEPENDENCY, 'not-ready')!;
    expect(msg).toContain('open pull requests');
    expect(msg).toContain('not signed in');
    expect(msg).toContain(GH_DEPENDENCY.ready!.fix);
    // The tool IS installed — telling them to install it is the old bug inverted.
    expect(msg).not.toContain("isn't installed");
    expect(msg).not.toContain(GH_DEPENDENCY.install);
  });

  it('says nothing for an ok tool', () => {
    expect(renderDependencyFault(GH_DEPENDENCY, 'ok')).toBeNull();
  });
});

describe('GH_DEPENDENCY readiness', () => {
  // `gh auth status` validates the token against the API, so it also fails when
  // the user is merely offline — and this probe REFUSES to ship. `gh auth token`
  // answers from local config, so its failure means one thing: no token.
  it('checks auth locally, so being offline is never mistaken for being logged out', () => {
    expect(GH_DEPENDENCY.ready?.args).toEqual(['auth', 'token']);
    expect(GH_DEPENDENCY.ready?.fix).toContain('gh auth login');
  });
});

describe('checkDependencyFaults', () => {
  it('reports nothing when every tool is usable', () => {
    expect(checkDependencyFaults(dependencyRegistry('claude'), () => true, () => true)).toEqual([]);
  });

  // The startup preflight and the status bar both want the whole picture at once,
  // across capabilities — missing AND signed-out, in registry order.
  it('reports every faulted tool, in registry order, with how each is faulted', () => {
    const faults = checkDependencyFaults(
      dependencyRegistry('claude'),
      (b) => b !== 'npm',
      () => false,
    );
    expect(faults).toEqual([
      { dep: NPM_DEPENDENCY, state: 'missing' },
      { dep: GH_DEPENDENCY, state: 'not-ready' },
    ]);
  });
});

describe('ensureCapability', () => {
  // Point-of-use guard: refuse BEFORE doing the work, so ship doesn't burn a
  // model call on a PR description it can't open, and a spin doesn't fail deep.
  const registry = dependencyRegistry('claude');
  const ready = () => true;

  it('returns nothing when the capability’s tools are all usable', () => {
    expect(ensureCapability('ship', registry, () => true, ready)).toEqual([]);
  });

  it('returns only the faulted tools of that capability', () => {
    expect(ensureCapability('ship', registry, (b) => b !== 'gh', ready)).toEqual([
      { dep: GH_DEPENDENCY, state: 'missing' },
    ]);
  });

  it('ignores tools faulted for other capabilities — ship still works without npm', () => {
    expect(ensureCapability('ship', registry, (b) => b !== 'npm', ready)).toEqual([]);
  });

  // The point of the readiness probe: refuse BEFORE runShipTicket asks a model to
  // write a PR description that `gh pr create` was never going to be able to open.
  it('faults an installed but not-ready tool', () => {
    expect(ensureCapability('ship', registry, () => true, () => false)).toEqual([
      { dep: GH_DEPENDENCY, state: 'not-ready' },
    ]);
  });
});

describe('renderMissingDependency', () => {
  // The ONE place install copy lives. github.ts used to hardcode its own duplicate.
  it('names the lost capability, the tool, and what to do', () => {
    const msg = renderMissingDependency(GH_DEPENDENCY);
    expect(msg).toContain('open pull requests');
    expect(msg).toContain('the GitHub CLI');
    expect(msg).toContain(GH_DEPENDENCY.install);
  });

  it('renders every registry entry without a placeholder', () => {
    for (const dep of dependencyRegistry('claude')) {
      const msg = renderMissingDependency(dep);
      expect(msg, dep.binary).not.toContain('undefined');
      expect(msg.startsWith('Karst can\'t '), dep.binary).toBe(true);
    }
  });
});

# Fix Default Sandbox Setup Hosts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand `DEFAULT_SETUP_HOSTS` to include `release-assets.githubusercontent.com` and `nodejs.org` on port 443 so sandboxed setup commands (`npm ci`) can fetch prebuilt native binaries and build headers without custom per-repository overrides.

**Architecture:** Update `DEFAULT_SETUP_HOSTS` in `src/manifest/sandboxSetupHosts.ts` to supply 5 default hosts (`registry.npmjs.org`, `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`, `nodejs.org`). Update unit tests to verify the expanded defaults, non-merging override semantics, and host validation. Synchronize documentation in `docs/arch/agent-cores.md`, `docs/arch/manifest-and-settings.md`, and `karst.example.yml`.

**Tech Stack:** TypeScript, Node.js ESM, Vitest.

**Spec:** Ticket FIX-DEFAULT-SANDBOX-SETUPHOSTS (T781, P17 / D251); builds on `@arch:AC-40`, `@arch:AC-36`, and `@arch:AC-33`.

## Global Constraints

- `DEFAULT_SETUP_HOSTS` order and contents: `['registry.npmjs.org', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'nodejs.org']`.
- All setup hosts remain HTTPS on port 443 (`SETUP_HOST_PORT = 443`).
- `setupHostsOf` continues strict replacement semantics: an explicitly declared list replaces defaults completely (no merge).
- `setupHostError` must validate every host in `DEFAULT_SETUP_HOSTS` successfully (`undefined`).
- Do NOT add `setupHosts` to `.karst/karst.yml`: with default hosts fixed, the repository needs no override.
- Docs block byte cap: `MAX_BLOCK_BYTES = 6200` enforced by `npm run docs:check`.
- Preserved comments and docstrings: update doc comments to explain *why* each default host is included.

---

### Task 1: Dedicated unit test suite and `DEFAULT_SETUP_HOSTS` update

**Files:**
- Create: `src/manifest/sandboxSetupHosts.test.ts`
- Modify: `src/manifest/sandboxSetupHosts.ts:1-18`

**Interfaces:**
- Consumes: `DEFAULT_SETUP_HOSTS`, `SETUP_HOST_PORT`, `setupHostError`, `setupHostsOf` from `src/manifest/sandboxSetupHosts.js`
- Produces: `DEFAULT_SETUP_HOSTS` containing 5 hosts (`registry.npmjs.org`, `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`, `nodejs.org`)

- [ ] **Step 1: Write the failing test in `src/manifest/sandboxSetupHosts.test.ts`**

Create `src/manifest/sandboxSetupHosts.test.ts` with assertions checking for the two new hosts in `DEFAULT_SETUP_HOSTS`, testing `setupHostsOf` defaults and replacement behavior, and verifying `setupHostError` on every default host:

```typescript
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETUP_HOSTS, SETUP_HOST_PORT, setupHostError, setupHostsOf } from './sandboxSetupHosts.js';

describe('sandboxSetupHosts', () => {
  it('exposes the 5 default setup hosts on port 443', () => {
    expect(SETUP_HOST_PORT).toBe(443);
    expect(DEFAULT_SETUP_HOSTS).toEqual([
      'registry.npmjs.org',
      'github.com',
      'objects.githubusercontent.com',
      'release-assets.githubusercontent.com',
      'nodejs.org',
    ]);
  });

  it('setupHostsOf returns DEFAULT_SETUP_HOSTS for undefined or empty list', () => {
    expect(setupHostsOf(undefined)).toEqual(DEFAULT_SETUP_HOSTS);
    expect(setupHostsOf([])).toEqual(DEFAULT_SETUP_HOSTS);
    expect(setupHostsOf(undefined)).toContain('release-assets.githubusercontent.com');
    expect(setupHostsOf(undefined)).toContain('nodejs.org');
  });

  it('setupHostsOf replaces defaults completely when declared (no merge)', () => {
    const custom = ['pypi.org', 'files.pythonhosted.org'];
    const result = setupHostsOf(custom);
    expect(result).toBe(custom);
    expect(result).not.toContain('registry.npmjs.org');
    expect(result).not.toContain('release-assets.githubusercontent.com');
  });

  it('every default setup host passes setupHostError validation', () => {
    for (const host of DEFAULT_SETUP_HOSTS) {
      expect(setupHostError(host)).toBeUndefined();
    }
  });

  it('validates host formats and rejects invalid host strings or host alias', () => {
    for (const valid of ['registry.npmjs.org', '*.githubusercontent.com', 'localhost', 'sub.domain.co.uk']) {
      expect(setupHostError(valid)).toBeUndefined();
    }
    for (const invalid of ['a b', 'x:443', 'https://x.io', '-x.io', 'host.docker.internal', '*', 'a,b']) {
      expect(setupHostError(invalid)).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npm run test:unit -- src/manifest/sandboxSetupHosts.test.ts
```
Expected: FAIL due to `DEFAULT_SETUP_HOSTS` missing `release-assets.githubusercontent.com` and `nodejs.org`.

- [ ] **Step 3: Update `src/manifest/sandboxSetupHosts.ts`**

Update `DEFAULT_SETUP_HOSTS` and its doc comment in `src/manifest/sandboxSetupHosts.ts`:

```typescript
/**
 * Hosts the sandbox may reach while `sandbox.setup` runs when a repository declares none (arch:AC-36, arch:AC-40).
 * - `registry.npmjs.org`: npm package registry metadata and tarball downloads.
 * - `github.com`: git repository dependencies and GitHub release landing pages.
 * - `objects.githubusercontent.com`: legacy and redirected GitHub release asset storage.
 * - `release-assets.githubusercontent.com`: modern GitHub release assets (prebuild-install/prebuildify native binaries).
 * - `nodejs.org`: Node.js header tarballs for node-gyp native compilation fallback.
 */
export const DEFAULT_SETUP_HOSTS: readonly string[] = [
  'registry.npmjs.org',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'nodejs.org',
];

/** Port every setup host is opened on: package registries and release downloads are HTTPS only. */
export const SETUP_HOST_PORT = 443;

const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** Why `host` is not a usable setup host, or undefined. The host alias is the baseline's, never a window. */
export function setupHostError(host: string): string | undefined {
  if (host.length > 253 || !HOST.test(host)) return `"${host}" is not a host name or *.suffix`;
  if (host === 'host.docker.internal') return 'must not be the host alias (baseline ports only)';
  return undefined;
}

export const setupHostsOf = (declared: readonly string[] | undefined): readonly string[] =>
  declared && declared.length > 0 ? declared : DEFAULT_SETUP_HOSTS;
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npm run test:unit -- src/manifest/sandboxSetupHosts.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/manifest/sandboxSetupHosts.ts src/manifest/sandboxSetupHosts.test.ts
git commit -m "fix(manifest): add release-assets.githubusercontent.com and nodejs.org to DEFAULT_SETUP_HOSTS"
```

---

### Task 2: Update existing unit tests pinning the old 3-host list

**Files:**
- Modify: `src/agent/sandboxSetupWindow.test.ts:97-104`
- Modify: `src/extension/ops/sandboxSetupOp.test.ts:40-50`

**Interfaces:**
- Consumes: `DEFAULT_SETUP_HOSTS` from `src/manifest/sandboxSetupHosts.js`

- [ ] **Step 1: Run existing tests to verify failure**

Run:
```bash
npm run test:unit -- src/agent/sandboxSetupWindow.test.ts src/extension/ops/sandboxSetupOp.test.ts
```
Expected: FAIL in `src/agent/sandboxSetupWindow.test.ts` (expecting 3 hosts instead of 5) and `src/extension/ops/sandboxSetupOp.test.ts` (expecting `'open registry.npmjs.org,github.com,objects.githubusercontent.com'`).

- [ ] **Step 2: Update `src/agent/sandboxSetupWindow.test.ts`**

In `src/agent/sandboxSetupWindow.test.ts`, update the `describe('setup hosts')` block around line 97:

```typescript
describe('setup hosts', () => {
  it('defaults and validates', () => {
    expect(setupHostsOf(undefined)).toEqual(DEFAULT_SETUP_HOSTS);
    expect(setupHostsOf([])).toEqual(DEFAULT_SETUP_HOSTS);
    expect(setupHostsOf(['a.io'])).toEqual(['a.io']);
    expect(DEFAULT_SETUP_HOSTS).toEqual([
      'registry.npmjs.org',
      'github.com',
      'objects.githubusercontent.com',
      'release-assets.githubusercontent.com',
      'nodejs.org',
    ]);
    for (const ok of ['registry.npmjs.org', '*.githubusercontent.com', 'localhost']) expect(setupHostError(ok)).toBeUndefined();
    for (const bad of ['a b', 'x:443', 'https://x.io', '-x.io', 'host.docker.internal', '*', 'a,b']) expect(setupHostError(bad)).toBeDefined();
  });
});
```

- [ ] **Step 3: Update `src/extension/ops/sandboxSetupOp.test.ts`**

In `src/extension/ops/sandboxSetupOp.test.ts`, update line 47 in test `'opens the declared setupHosts around the setup, the defaults when none are declared'`:

```typescript
  it('opens the declared setupHosts around the setup, the defaults when none are declared', async () => {
    const custom = rig({ setup: 'npm ci', setupHosts: ['pypi.org'] });
    await provisionTicketSandbox(custom.deps, 7);
    expect(custom.windows).toEqual(['open pypi.org', 'close']);
    resetSetupLocks();
    const plain = rig({ setup: 'npm ci' });
    await provisionTicketSandbox(plain.deps, 7);
    expect(plain.windows).toEqual([
      'open registry.npmjs.org,github.com,objects.githubusercontent.com,release-assets.githubusercontent.com,nodejs.org',
      'close',
    ]);
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npm run test:unit -- src/agent/sandboxSetupWindow.test.ts src/extension/ops/sandboxSetupOp.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/sandboxSetupWindow.test.ts src/extension/ops/sandboxSetupOp.test.ts
git commit -m "test(sandbox): update setup window tests for 5-host default list"
```

---

### Task 3: Update documentation and example configuration

**Files:**
- Modify: `docs/arch/agent-cores.md:436`
- Modify: `docs/arch/manifest-and-settings.md:68`
- Modify: `karst.example.yml:320-322`

**Interfaces:**
- Consumes: `@arch:AC-40`, `@arch:AC-36`

- [ ] **Step 1: Update `docs/arch/agent-cores.md`**

In `docs/arch/agent-cores.md` inside block `## [@arch:AC-40] Sandbox dependency setup and its network window`, update the Network window sentence:

Change:
```markdown
**Network window** (`SessionRunner.setupWindow`, `manifest/sandboxSetupHosts.ts`): the setup (and only it) runs with the repository's `sandbox.setupHosts` (default `registry.npmjs.org`, `github.com`, `objects.githubusercontent.com`; port 443; host or `*.suffix`) reachable, closed in a `finally` after a failed, timed-out or aborted setup too.
```

To:
```markdown
**Network window** (`SessionRunner.setupWindow`, `manifest/sandboxSetupHosts.ts`): the setup (and only it) runs with the repository's `sandbox.setupHosts` (default `registry.npmjs.org`, `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`, `nodejs.org`; port 443; host or `*.suffix`) reachable, closed in a `finally` after a failed, timed-out or aborted setup too.
```

- [ ] **Step 2: Update `docs/arch/manifest-and-settings.md`**

In `docs/arch/manifest-and-settings.md` line 68, update the `sandbox.setupHosts` definition:

Change:
```markdown
`sandbox.setupHosts` (optional, non-empty list of host names or `*.suffix`, no port, never `host.docker.internal`) lists the only extra hosts reachable while the setup runs (default `registry.npmjs.org`, `github.com`, `objects.githubusercontent.com`; `arch:AC-36`).
```

To:
```markdown
`sandbox.setupHosts` (optional, non-empty list of host names or `*.suffix`, no port, never `host.docker.internal`) lists the only extra hosts reachable while the setup runs (default `registry.npmjs.org`, `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`, `nodejs.org`; `arch:AC-36`).
```

- [ ] **Step 3: Update `karst.example.yml`**

In `karst.example.yml` lines 320-322:

Change:
```yaml
    #   # Hosts reachable ONLY while setup runs (port 443; default: registry.npmjs.org, github.com,
    #   # objects.githubusercontent.com). Closed again afterwards.
    #   setupHosts: [registry.npmjs.org, github.com, objects.githubusercontent.com]
```

To:
```yaml
    #   # Hosts reachable ONLY while setup runs (port 443; default: registry.npmjs.org, github.com,
    #   # objects.githubusercontent.com, release-assets.githubusercontent.com, nodejs.org). Closed again afterwards.
    #   setupHosts: [registry.npmjs.org, github.com, objects.githubusercontent.com, release-assets.githubusercontent.com, nodejs.org]
```

- [ ] **Step 4: Verify documentation integrity and block limits**

Run:
```bash
npm run docs:check
```
Expected: PASS with 0 errors.

- [ ] **Step 5: Commit**

```bash
git add docs/arch/agent-cores.md docs/arch/manifest-and-settings.md karst.example.yml
git commit -m "docs(sandbox): document release-assets and nodejs.org in default setupHosts"
```

---

### Task 4: Full verification and sanity checks

**Files:**
- Test verification across all affected code and repo integrity

- [ ] **Step 1: Run type checking**

Run:
```bash
npm run typecheck
```
Expected: PASS with 0 errors.

- [ ] **Step 2: Run full unit test suite**

Run:
```bash
npm run test:unit
```
Expected: All test suites PASS.

- [ ] **Step 3: Run docs check**

Run:
```bash
npm run docs:check
```
Expected: PASS.

- [ ] **Step 4: Verify .karst/karst.yml was not modified**

Run:
```bash
git status --short .karst/karst.yml
```
Expected: Empty output (no changes to `.karst/karst.yml`).

- [ ] **Step 5: Verify git log and working tree cleanliness**

Run:
```bash
git status
git log -n 4 --oneline
```
Expected: Working tree clean, commits match task breakdown.

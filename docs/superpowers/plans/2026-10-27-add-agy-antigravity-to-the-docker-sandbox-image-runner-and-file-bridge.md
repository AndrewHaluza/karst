# Add agy (antigravity) to the Docker Sandbox Image, Runner, and File Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add support for `agy` (antigravity) in the plain-Docker sandbox backend: install pinned agy 1.4.6 in the Dockerfile image, widen allowlist proxy domains for Google/Antigravity endpoints, enable autonomous mode for agy on enforcing runners, write file-bridge marker and ack scripts for antigravity, and provide symlink-safe, mtime-aware credential seeding and `/home/node/.gemini` bind-mounting.

**Architecture:** Plain Docker (`src/agent/docker/`, `@arch:AC-33`) is extended to support `antigravity`/`agy` alongside `opencode`/`opencode2`. `DockerRunnerCore` is introduced in `dockerImage.ts` as `DockerCore | 'antigravity' | 'agy'` without prematurely modifying `DOCKER_CORES` in `sandboxCores.ts`. Host credentials from `~/.gemini/antigravity-cli/` are mirrored into the ticket's bridge directory with strict symlink safety and mounted one level deep at `/home/node/.gemini` to avoid root-owned directory permissions issues on Linux tmpfs.

**Tech Stack:** TypeScript, Node.js (v22), Docker, Vitest, bash/sh.

**Spec:** Ticket ADD-AGY-ANTIGRAVITY-TO-THE (T812, P29 / D249); design constraints `@arch:AC-26`, `@arch:AC-31`, `@arch:AC-32`, `@arch:AC-33`, `@arch:AC-34`, `@arch:AC-38`, commits `70f408d4df6`, `61b3f6ec3bc`, `b2ee81ca562`, `ab666a1eb08` (T772).

## Global Constraints

- Backend choice is plain `docker`, not `sbx` (`sbx` v0.48.0 has no agy microVM template or credential proxy).
- One-level bind mount at `/home/node/.gemini` (not `/home/node/.gemini/antigravity-cli`), mounting `<bridgeDir>/antigravity/gemini` with pre-created subdirectories `antigravity-cli` and `config` to avoid root-owned intermediate directories created by runc inside the Linux tmpfs.
- Pin `AGY_VERSION = '1.4.6'` (`1.4.6-4884751325200384`) and bump `OPENCODE_IMAGE_REVISION` from `'r3'` to `'r4'`.
- Pass `--build-arg AGY=${AGY_VERSION}` in `imageBuildArgs`.
- SHA-512 verification in Dockerfile for `arm64`: `0daa84244922bd648f940d44dfc33ace8c26217cd710ff116902eb8708829a0cfe70640f0d6b480243442881c9aeb4a905a9aa7887dd8a70159aa0f1a4f98a8f` (`linux-arm/cli_linux_arm64.tar.gz`) and `amd64`: `4e1244b8b8c1280552f59c1b24b76a9245db9c80032aec6db28fb86033d6088abc30a90dad432d2b246c28fdd87d82abb48727d5ff88ba1d5d4ec76b33348e7d` (`linux-x64/cli_linux_x64.tar.gz`).
- Pre-create `/home/node/.gemini/antigravity-cli` and `/home/node/.gemini/config` owned by `node:node` in the Dockerfile.
- Define `export type DockerRunnerCore = DockerCore | 'antigravity' | 'agy'` in `dockerImage.ts` and use it in `containerBinary`, `dockerRunArgs.ts`, `dockerRunner.ts`, and `resolveDocker.ts` so `D249` passes `npm run typecheck` before `D250` updates `DOCKER_CORES` in `sandboxCores.ts`.
- Map `'antigravity' | 'agy'` -> `'agy'` in `containerBinary`.
- Allowlist endpoints: `googleapis.com`, `accounts.google.com`, `antigravity.google`, `antigravity.google.com`, `antigravity-unleash.goog`.
- For `'antigravity' | 'agy'` when `enforcesSandbox: true`, autonomous launch returns `{ autonomous: true, args: ['--dangerously-skip-permissions'], env: (b) => ({ ...b }) }`. Host launches remain `{ autonomous: false, args: [], env: (b) => ({ ...b }) }`.
- In `AntigravityAdapter.buildInteractiveCommand`, call `writeBridgeScripts(join(opts.hookChannel.configDir, 'antigravity'))` when `opts.hookChannel && isFileChannel(opts.hookChannel.endpointUrl, opts.hookChannel.runDir)`.
- In `seedAgyCredentials`, verify directory segments `<bridgeDir>/antigravity`, `<bridgeDir>/antigravity/gemini`, `<bridgeDir>/antigravity/gemini/antigravity-cli`, and `<bridgeDir>/antigravity/gemini/config` using `lstat` (`isDirectory() && !isSymbolicLink()`, mode `0o700`).
- Copy files `['antigravity-oauth-token', 'jetski_state.pbtxt', 'installation_id']` from `<hostHome>/.gemini/antigravity-cli/` to `<bridgeDir>/antigravity/gemini/antigravity-cli/` using exclusive temp files (`'wx'`, mode `0o600`) + `rename`, only if destination is missing or `srcStat.mtimeMs > destStat.mtimeMs`.

---

### Task 1: Extend Allowlist Proxy with Google and Antigravity Endpoints

**Files:**
- Modify: `src/agent/docker/proxySidecar.ts:11-16`
- Test: `src/agent/docker/proxySidecar.test.ts:1-20`

**Interfaces:**
- Consumes: `SANDBOX_NETWORK_ALLOWLIST` from `src/agent/sandbox.js`
- Produces: `DOCKER_ALLOWLIST`, `GOOGLE_ANTIGRAVITY_DOMAINS` in `src/agent/docker/proxySidecar.ts`

- [ ] **Step 1: Write the failing test**

In `src/agent/docker/proxySidecar.test.ts`, update the domain list test:

```typescript
  it('allowlists the ST1 domains plus the opencode and antigravity providers', () => {
    expect(DOCKER_ALLOWLIST).toEqual([
      ...SANDBOX_NETWORK_ALLOWLIST,
      'opencode.ai',
      'openrouter.ai',
      'models.dev',
      'googleapis.com',
      'accounts.google.com',
      'antigravity.google',
      'antigravity.google.com',
      'antigravity-unleash.goog',
    ]);
    expect(PROXY_URL).toBe('http://karst-proxy:3128');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- src/agent/docker/proxySidecar.test.ts`
Expected: FAIL with assertion mismatch in `DOCKER_ALLOWLIST`.

- [ ] **Step 3: Write minimal implementation**

In `src/agent/docker/proxySidecar.ts`:

```typescript
/** opencode's own endpoints (ST2B exp 8): `models.opencode.ai` is covered by the suffix. */
export const OPENCODE_PROVIDER_DOMAINS: readonly string[] = ['opencode.ai', 'openrouter.ai', 'models.dev'];

export const GOOGLE_ANTIGRAVITY_DOMAINS: readonly string[] = [
  'googleapis.com',
  'accounts.google.com',
  'antigravity.google',
  'antigravity.google.com',
  'antigravity-unleash.goog',
];

export const DOCKER_ALLOWLIST: readonly string[] = [
  ...SANDBOX_NETWORK_ALLOWLIST,
  ...OPENCODE_PROVIDER_DOMAINS,
  ...GOOGLE_ANTIGRAVITY_DOMAINS,
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- src/agent/docker/proxySidecar.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/docker/proxySidecar.ts src/agent/docker/proxySidecar.test.ts
git commit -m "feat(docker): add Google and Antigravity domains to DOCKER_ALLOWLIST"
```

---

### Task 2: Enable Autonomous Launch for Antigravity and Agy in Sandboxes

**Files:**
- Modify: `src/agent/autonomousLaunch.ts:60-70`
- Test: `src/agent/autonomousLaunch.test.ts:8-27`

**Interfaces:**
- Consumes: `SessionRunner.enforcesSandbox` from `src/agent/sessionRunner.ts`
- Produces: `autonomousLaunch(core: string, runner: Pick<SessionRunner, 'enforcesSandbox'>): AutonomousLaunch`

- [ ] **Step 1: Write the failing test**

In `src/agent/autonomousLaunch.test.ts`, update lines 8-27:

```typescript
  it.each(['claude', 'codex', 'opencode', 'opencode2', 'agy', 'antigravity'])('never relaxes %s on the host runner', (core) => {
    const env = { OPENCODE_CONFIG_CONTENT: '{"model":"m"}', OPENCODE_PERMISSION: '{"bash":{}}' };
    const launch = autonomousLaunch(core, HOST_SESSION_RUNNER);
    expect(launch.autonomous).toBe(false);
    expect(launch.args).toEqual([]);
    expect(launch.env(env)).toEqual(env);
  });

  it('keeps claude/codex flags and leaves their env alone on an enforcing runner', () => {
    expect(autonomousLaunch('claude', enforcing).args).toEqual(['--dangerously-skip-permissions']);
    expect(autonomousLaunch('codex', enforcing).args).toEqual(['-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"']);
    expect(autonomousLaunch('claude', enforcing).env({ A: '1' })).toEqual({ A: '1' });
  });

  it.each(['antigravity', 'agy'])('%s skips permissions on an enforcing runner and leaves env alone', (core) => {
    const launch = autonomousLaunch(core, enforcing);
    expect(launch.autonomous).toBe(true);
    expect(launch.args).toEqual(['--dangerously-skip-permissions']);
    expect(launch.env({ A: '1' })).toEqual({ A: '1' });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- src/agent/autonomousLaunch.test.ts`
Expected: FAIL ("agy skips permissions on an enforcing runner and leaves env alone").

- [ ] **Step 3: Write minimal implementation**

In `src/agent/autonomousLaunch.ts`, update `autonomousLaunch`:

```typescript
export function autonomousLaunch(core: string, runner: Pick<SessionRunner, 'enforcesSandbox'>): AutonomousLaunch {
  if (runner.enforcesSandbox !== true) return PROMPTED;
  if (core === 'claude') return { autonomous: true, args: ['--dangerously-skip-permissions'], env: PROMPTED.env };
  if (core === 'codex') return { autonomous: true, args: ['-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"'], env: PROMPTED.env };
  if (core === 'opencode' || core === 'opencode2') return { autonomous: true, args: [], env: opencodeAllowAll };
  if (core === 'antigravity' || core === 'agy') return { autonomous: true, args: ['--dangerously-skip-permissions'], env: PROMPTED.env };
  return PROMPTED;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- src/agent/autonomousLaunch.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/autonomousLaunch.ts src/agent/autonomousLaunch.test.ts
git commit -m "feat(agent): enable autonomous mode with --dangerously-skip-permissions for antigravity in sandbox"
```

---

### Task 3: File Bridge Scripts in AntigravityAdapter

**Files:**
- Modify: `src/agent/antigravity.ts:1-25, 259-312`
- Test: `src/agent/antigravity.test.ts:47-110`

**Interfaces:**
- Consumes: `writeBridgeScripts` and `isFileChannel` from `src/agent/hookBridgeFiles.ts`
- Produces: `AntigravityAdapter.buildInteractiveCommand(opts: InteractiveCommandOpts): InteractiveCommand` creating bridge scripts under `<opts.hookChannel.configDir>/antigravity`

- [ ] **Step 1: Write the failing test**

In `src/agent/antigravity.test.ts`, under `describe('buildInteractiveCommand', ...)`:

```typescript
    it('writes bridge scripts into <configDir>/antigravity when given a file hook channel', () => {
      const adapter = new AntigravityAdapter();
      const configDir = getTmp();
      const hookChannel = {
        endpointUrl: 'file:///tmp/events.ndjson',
        runDir: '/karst-bridge/7',
        configDir,
      };
      adapter.buildInteractiveCommand({ cwd: '/test', hookChannel });
      expect(existsSync(join(configDir, 'antigravity', 'emit-marker.cjs'))).toBe(true);
      expect(existsSync(join(configDir, 'antigravity', 'emit-ack.cjs'))).toBe(true);
      expect(existsSync(join(configDir, 'antigravity', 'bridge.cjs'))).toBe(true);
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- src/agent/antigravity.test.ts`
Expected: FAIL with file not found.

- [ ] **Step 3: Write minimal implementation**

In `src/agent/antigravity.ts`, import `isFileChannel` and `writeBridgeScripts` from `./hookBridgeFiles.js`:

```typescript
import { isFileChannel, writeBridgeScripts } from './hookBridgeFiles.js';
```

And in `AntigravityAdapter.buildInteractiveCommand(opts: InteractiveCommandOpts)`:

```typescript
    if (opts.hookChannel && isFileChannel(opts.hookChannel.endpointUrl, opts.hookChannel.runDir)) {
      writeBridgeScripts(join(opts.hookChannel.configDir, 'antigravity'));
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- src/agent/antigravity.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/antigravity.ts src/agent/antigravity.test.ts
git commit -m "feat(antigravity): write file-bridge scripts into <configDir>/antigravity for file channels"
```

---

### Task 4: Docker Image Pinning, Revision Bump, and `DockerRunnerCore`

**Files:**
- Modify: `src/agent/docker/dockerImage.ts:1-65`
- Modify: `sandbox/opencode/Dockerfile:17-71`
- Test: `src/agent/docker/dockerImage.test.ts:80-103`

**Interfaces:**
- Consumes: `DOCKER_CORES`, `DockerCore` from `src/agent/sandboxCores.ts`
- Produces: `AGY_VERSION`, `DockerRunnerCore`, updated `OPENCODE_IMAGE_REVISION = 'r4'`, updated `containerBinary(core: DockerRunnerCore): string`, updated `imageBuildArgs(contextDir: string): string[]`

- [ ] **Step 1: Write the failing tests**

In `src/agent/docker/dockerImage.test.ts`:

```typescript
  it('builds with the pinned versions as build args, context last (argv array)', () => {
    expect(imageBuildArgs('/ext/dist/sandbox/opencode')).toEqual([
      'build', '--tag', OPENCODE_IMAGE,
      '--build-arg', `OC1=${OPENCODE_V1_VERSION}`,
      '--build-arg', `OC2=${OPENCODE_V2_VERSION}`,
      '--build-arg', `PW=${PLAYWRIGHT_VERSION}`,
      '--build-arg', `AGY=${AGY_VERSION}`,
      '/ext/dist/sandbox/opencode',
    ]);
  });

  it('maps each core to its launcher inside the image', () => {
    expect(containerBinary('opencode')).toBe('opencode1');
    expect(containerBinary('opencode2')).toBe('opencode2');
    expect(containerBinary('antigravity')).toBe('agy');
    expect(containerBinary('agy')).toBe('agy');
  });

  it('Dockerfile downloads pinned agy, verifies sha512, and pre-creates node-owned gemini dirs', () => {
    const dockerfile = readFileSync(
      fileURLToPath(new URL('../../../sandbox/opencode/Dockerfile', import.meta.url)),
      'utf8',
    );
    expect(dockerfile).toContain('ARG AGY=1.4.6');
    expect(dockerfile).toContain('https://storage.googleapis.com/antigravity-public/antigravity-cli/');
    expect(dockerfile).toContain('0daa84244922bd648f940d44dfc33ace8c26217cd710ff116902eb8708829a0cfe70640f0d6b480243442881c9aeb4a905a9aa7887dd8a70159aa0f1a4f98a8f');
    expect(dockerfile).toContain('4e1244b8b8c1280552f59c1b24b76a9245db9c80032aec6db28fb86033d6088abc30a90dad432d2b246c28fdd87d82abb48727d5ff88ba1d5d4ec76b33348e7d');
    expect(dockerfile).toContain('/usr/local/bin/agy');
    expect(dockerfile).toContain('/home/node/.gemini/antigravity-cli');
    expect(dockerfile).toContain('/home/node/.gemini/config');
  });
```

Also check that `OPENCODE_IMAGE_REVISION` is `'r4'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- src/agent/docker/dockerImage.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

In `src/agent/docker/dockerImage.ts`:
- Define `export const AGY_VERSION = '1.4.6';`
- Update `export const OPENCODE_IMAGE_REVISION = 'r4';`
- Define `export type DockerRunnerCore = DockerCore | 'antigravity' | 'agy';`
- Update `imageBuildArgs`:
  ```typescript
  export function imageBuildArgs(contextDir: string): string[] {
    return [
      'build', '--tag', OPENCODE_IMAGE,
      '--build-arg', `OC1=${OPENCODE_V1_VERSION}`,
      '--build-arg', `OC2=${OPENCODE_V2_VERSION}`,
      '--build-arg', `PW=${PLAYWRIGHT_VERSION}`,
      '--build-arg', `AGY=${AGY_VERSION}`,
      contextDir,
    ];
  }
  ```
- Update `containerBinary`:
  ```typescript
  export function containerBinary(core: DockerRunnerCore): string {
    if (core === 'antigravity' || core === 'agy') return 'agy';
    return core === 'opencode' ? 'opencode1' : 'opencode2';
  }
  ```

In `sandbox/opencode/Dockerfile`:
- Add `curl` to `apt-get install` list at line 25.
- Add `ARG AGY=1.4.6` at line 21.
- Add installation step before switching to `USER node`:
  ```dockerfile
  RUN set -e; \
      ARCH="$(dpkg --print-architecture)"; \
      case "${ARCH}" in \
        arm64) \
          CLI_FILE="linux-arm/cli_linux_arm64.tar.gz"; \
          SHA512="0daa84244922bd648f940d44dfc33ace8c26217cd710ff116902eb8708829a0cfe70640f0d6b480243442881c9aeb4a905a9aa7887dd8a70159aa0f1a4f98a8f"; \
          ;; \
        amd64) \
          CLI_FILE="linux-x64/cli_linux_x64.tar.gz"; \
          SHA512="4e1244b8b8c1280552f59c1b24b76a9245db9c80032aec6db28fb86033d6088abc30a90dad432d2b246c28fdd87d82abb48727d5ff88ba1d5d4ec76b33348e7d"; \
          ;; \
        *) echo "Unsupported architecture: ${ARCH}" >&2; exit 1 ;; \
      esac; \
      URL="https://storage.googleapis.com/antigravity-public/antigravity-cli/1.4.6-4884751325200384/${CLI_FILE}"; \
      curl -fsSL "${URL}" -o /tmp/agy.tar.gz; \
      echo "${SHA512}  /tmp/agy.tar.gz" | sha512sum -c -; \
      tar -xzf /tmp/agy.tar.gz -C /tmp; \
      mv /tmp/antigravity /usr/local/bin/agy; \
      chmod +x /usr/local/bin/agy; \
      rm /tmp/agy.tar.gz
  ```
- Pre-create `/home/node/.gemini/antigravity-cli` and `/home/node/.gemini/config` in the `mkdir` step:
  ```dockerfile
  RUN mkdir -p /home/node/.local/share/opencode /home/node/.local/state /home/node/.config \
      /home/node/.cache /home/node/.gemini/antigravity-cli /home/node/.gemini/config /work \
      && chown -R node:node /home/node /work
  ```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- src/agent/docker/dockerImage.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/docker/dockerImage.ts sandbox/opencode/Dockerfile src/agent/docker/dockerImage.test.ts
git commit -m "feat(docker): pin agy 1.4.6 in Dockerfile, bump image revision to r4, and define DockerRunnerCore"
```

---

### Task 5: Bind-Mount `/home/node/.gemini` in `interactiveRunArgs`

**Files:**
- Modify: `src/agent/docker/dockerRunArgs.ts:1-155`
- Test: `src/agent/docker/dockerRunArgs.test.ts:140-165`

**Interfaces:**
- Consumes: `DockerRunnerCore` from `src/agent/docker/dockerImage.js`
- Produces: `InteractiveArgsInput` with `core: DockerRunnerCore`, and `interactiveRunArgs` mounting `<bridgeDir>/antigravity/gemini` at `/home/node/.gemini` for `antigravity`/`agy`.

- [ ] **Step 1: Write the failing tests**

In `src/agent/docker/dockerRunArgs.test.ts`, under `describe('interactiveRunArgs bridge mount', ...)`:

```typescript
  it('mounts <bridgeDir>/antigravity/gemini at /home/node/.gemini for antigravity core when bridgeDir is set', () => {
    const withBridge = interactiveRunArgs({ ...base, core: 'antigravity', ticketId: 7, bridgeDir: '/g/events/7' });
    expect(withBridge).toContain('type=bind,source=/g/events/7/antigravity/gemini,target=/home/node/.gemini');
    expect(withBridge.join(' ')).not.toContain('readonly,target=/home/node/.gemini');
  });

  it('mounts <bridgeDir>/antigravity/gemini at /home/node/.gemini for agy core when bridgeDir is set', () => {
    const withBridge = interactiveRunArgs({ ...base, core: 'agy', ticketId: 7, bridgeDir: '/g/events/7' });
    expect(withBridge).toContain('type=bind,source=/g/events/7/antigravity/gemini,target=/home/node/.gemini');
  });

  it('does not mount /home/node/.gemini for opencode even when bridgeDir is set', () => {
    const withBridge = interactiveRunArgs({ ...base, core: 'opencode', ticketId: 7, bridgeDir: '/g/events/7' });
    expect(withBridge.join(' ')).not.toContain('/home/node/.gemini');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- src/agent/docker/dockerRunArgs.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

In `src/agent/docker/dockerRunArgs.ts`:
- Import `join` from `node:path`.
- Import `type DockerRunnerCore` from `./dockerImage.js`.
- In `InteractiveArgsInput`:
  ```typescript
  export interface InteractiveArgsInput {
    readonly names: DockerNames;
    readonly core: DockerRunnerCore;
    readonly user: LinuxUser | undefined;
    readonly authFile: string | undefined;
    readonly hostWorktreePath: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly ticketId?: number;
    readonly bridgeDir?: string;
    readonly memory?: DockerMemoryLimits;
  }
  ```
- In `interactiveRunArgs`:
  ```typescript
  const geminiMount =
    (input.core === 'antigravity' || input.core === 'agy') && input.bridgeDir !== undefined
      ? ['--mount', bindMount(join(input.bridgeDir, 'antigravity', 'gemini'), `${CONTAINER_HOME}/.gemini`, false)]
      : [];
  ```
  Add `...geminiMount` into the return array after `...bridge`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- src/agent/docker/dockerRunArgs.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/docker/dockerRunArgs.ts src/agent/docker/dockerRunArgs.test.ts
git commit -m "feat(docker): bind-mount <bridgeDir>/antigravity/gemini at /home/node/.gemini for antigravity and agy"
```

---

### Task 6: Symlink-Safe, `mtime`-Aware Auth Seeding in `dockerCredentials.ts`

**Files:**
- Modify: `src/agent/docker/dockerCredentials.ts:1-55`
- Test: `src/agent/docker/dockerCredentials.test.ts:40-75`

**Interfaces:**
- Consumes: Node filesystem APIs (`lstat`, `mkdir`, `chmod`, `readFile`, `writeFile`, `rename`, `stat`)
- Produces: `seedAgyCredentials(input: SeedAgyInput): Promise<SeedResult>` where:
  - Directory segments `<bridgeDir>/antigravity`, `<bridgeDir>/antigravity/gemini`, `<bridgeDir>/antigravity/gemini/antigravity-cli`, `<bridgeDir>/antigravity/gemini/config` are verified with `lstat` (`isDirectory() && !isSymbolicLink()`, mode `0o700`).
  - Files `['antigravity-oauth-token', 'jetski_state.pbtxt', 'installation_id']` are copied from `<hostHome>/.gemini/antigravity-cli/` to `<bridgeDir>/antigravity/gemini/antigravity-cli/` via exclusive temp files (`'wx'`, mode `0o600`) + `rename`, only if destination is missing or `srcStat.mtimeMs > destStat.mtimeMs`. Missing host files are skipped with a debug note.

- [ ] **Step 1: Write the failing tests**

In `src/agent/docker/dockerCredentials.test.ts`:

```typescript
describe('seedAgyCredentials', () => {
  it('creates directory segments with mode 0o700 and copies host credential files', async () => {
    const bridgeDir = mkdtempSync(join(tmpdir(), 'karst-bridge-test-'));
    const hostHome = mkdtempSync(join(tmpdir(), 'karst-hosthome-test-'));
    const hostAgyDir = join(hostHome, '.gemini', 'antigravity-cli');
    mkdirSync(hostAgyDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(hostAgyDir, 'antigravity-oauth-token'), 'token-data', { mode: 0o600 });
    writeFileSync(join(hostAgyDir, 'installation_id'), 'id-data', { mode: 0o600 });

    const debug = vi.fn();
    const result = await seedAgyCredentials({ bridgeDir, hostHome, debug });
    expect(result).toEqual({ ok: true });

    const targetDir = join(bridgeDir, 'antigravity', 'gemini', 'antigravity-cli');
    expect(existsSync(join(targetDir, 'antigravity-oauth-token'))).toBe(true);
    expect(readFileSync(join(targetDir, 'antigravity-oauth-token'), 'utf8')).toBe('token-data');
    expect(existsSync(join(targetDir, 'installation_id'))).toBe(true);
    expect(readFileSync(join(targetDir, 'installation_id'), 'utf8')).toBe('id-data');
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('jetski_state.pbtxt'));

    rmSync(bridgeDir, { recursive: true, force: true });
    rmSync(hostHome, { recursive: true, force: true });
  });

  it('refuses when any segment is a symbolic link', async () => {
    const bridgeDir = mkdtempSync(join(tmpdir(), 'karst-bridge-test-'));
    const fakeTarget = mkdtempSync(join(tmpdir(), 'karst-fake-target-'));
    symlinkSync(fakeTarget, join(bridgeDir, 'antigravity'));

    const result = await seedAgyCredentials({ bridgeDir });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/symlink|symbolic link/i);

    rmSync(bridgeDir, { recursive: true, force: true });
    rmSync(fakeTarget, { recursive: true, force: true });
  });

  it('preserves newer destination credential files refreshed in the container', async () => {
    const bridgeDir = mkdtempSync(join(tmpdir(), 'karst-bridge-test-'));
    const hostHome = mkdtempSync(join(tmpdir(), 'karst-hosthome-test-'));
    const hostAgyDir = join(hostHome, '.gemini', 'antigravity-cli');
    const targetDir = join(bridgeDir, 'antigravity', 'gemini', 'antigravity-cli');
    mkdirSync(hostAgyDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });

    writeFileSync(join(hostAgyDir, 'antigravity-oauth-token'), 'old-token');
    // Set host mtime in the past
    utimesSync(join(hostAgyDir, 'antigravity-oauth-token'), new Date(1000), new Date(1000));

    writeFileSync(join(targetDir, 'antigravity-oauth-token'), 'newer-container-token');
    utimesSync(join(targetDir, 'antigravity-oauth-token'), new Date(2000), new Date(2000));

    const result = await seedAgyCredentials({ bridgeDir, hostHome });
    expect(result).toEqual({ ok: true });
    expect(readFileSync(join(targetDir, 'antigravity-oauth-token'), 'utf8')).toBe('newer-container-token');

    rmSync(bridgeDir, { recursive: true, force: true });
    rmSync(hostHome, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- src/agent/docker/dockerCredentials.test.ts`
Expected: FAIL ("seedAgyCredentials is not defined").

- [ ] **Step 3: Write minimal implementation**

In `src/agent/docker/dockerCredentials.ts`:
- Import `lstat`, `mkdir`, `chmod`, `readFile`, `writeFile`, `rename`, `stat`, `rm` from `node:fs/promises`.
- Import `homedir` from `node:os`.
- Import `join` from `node:path`.
- Implement `seedAgyCredentials`:

```typescript
export const AGY_CREDENTIAL_FILES = ['antigravity-oauth-token', 'jetski_state.pbtxt', 'installation_id'] as const;

export interface SeedAgyInput {
  readonly bridgeDir: string;
  readonly hostHome?: string;
  readonly debug?: (message: string) => void;
}

export async function seedAgyCredentials(input: SeedAgyInput): Promise<SeedResult> {
  const debug = input.debug ?? (() => undefined);
  const bridgeDir = input.bridgeDir;
  const segments = [
    join(bridgeDir, 'antigravity'),
    join(bridgeDir, 'antigravity', 'gemini'),
    join(bridgeDir, 'antigravity', 'gemini', 'antigravity-cli'),
    join(bridgeDir, 'antigravity', 'gemini', 'config'),
  ];

  for (const seg of segments) {
    try {
      const st = await lstat(seg);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        return { ok: false, reason: `antigravity seed: ${seg} is not a plain directory or is a symbolic link` };
      }
      if (process.platform !== 'win32' && (st.mode & 0o777) !== 0o700) {
        await chmod(seg, 0o700);
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        await mkdir(seg, { mode: 0o700, recursive: false });
        if (process.platform !== 'win32') {
          await chmod(seg, 0o700);
        }
      } else {
        return { ok: false, reason: `antigravity seed: cannot access ${seg}: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
  }

  const hostHome = input.hostHome ?? process.env.HOME ?? homedir();
  const srcDir = join(hostHome, '.gemini', 'antigravity-cli');
  const destDir = join(bridgeDir, 'antigravity', 'gemini', 'antigravity-cli');

  for (const filename of AGY_CREDENTIAL_FILES) {
    const srcPath = join(srcDir, filename);
    const destPath = join(destDir, filename);

    let srcStat;
    try {
      srcStat = await stat(srcPath);
    } catch {
      debug(`[docker] agy credential: ${filename} missing on host, skipping`);
      continue;
    }

    try {
      const destStat = await stat(destPath);
      if (destStat.mtimeMs >= srcStat.mtimeMs) {
        debug(`[docker] agy credential: ${filename} destination is up to date or newer, skipping`);
        continue;
      }
    } catch {
      // Destination is missing, proceed to copy
    }

    const tmpPath = join(destDir, `.${filename}.${process.pid}.${Date.now()}.tmp`);
    try {
      const content = await readFile(srcPath);
      await writeFile(tmpPath, content, { flag: 'wx', mode: 0o600 });
      await rename(tmpPath, destPath);
      debug(`[docker] agy credential: copied ${filename}`);
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      return { ok: false, reason: `antigravity seed: failed to write ${filename}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- src/agent/docker/dockerCredentials.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/docker/dockerCredentials.ts src/agent/docker/dockerCredentials.test.ts
git commit -m "feat(docker): implement symlink-safe, mtime-aware seedAgyCredentials"
```

---

### Task 7: Plumb `DockerRunnerCore`, `bridgeDir`, and Credential Seeding into `dockerRunner.ts` and `resolveDocker.ts`

**Files:**
- Modify: `src/agent/docker/dockerRunner.ts:1-260`
- Modify: `src/agent/docker/resolveDocker.ts:1-97`
- Test: `src/agent/docker/dockerRunner.test.ts`
- Test: `src/agent/docker/resolveDocker.test.ts`

**Interfaces:**
- Consumes: `DockerRunnerCore` from `./dockerImage.js`, `seedAgyCredentials` from `./dockerCredentials.js`
- Produces:
  - `DockerRunnerOptions.core: DockerRunnerCore`
  - `PrepareInput.core: DockerRunnerCore`
  - `PrepareInput.bridgeDir?: string`
  - `DockerResolveInput.bridgeDir?: string`
  - Calling `seedAgyCredentials` in `prepareDockerSandbox` when `core === 'antigravity' || core === 'agy'` and `bridgeDir` is set.

- [ ] **Step 1: Write the failing tests**

In `src/agent/docker/resolveDocker.test.ts`:
Add a test verifying that `bridgeDir` in `DockerResolveInput` is threaded through into `prepare`:

```typescript
  it('threads bridgeDir through to prepareDockerSandbox', async () => {
    const prepare = vi.fn().mockResolvedValue({ ok: true });
    await resolveDocker({ ...base, core: 'opencode', bridgeDir: '/bridge/dir/7', deps: deps({ prepare }) });
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ bridgeDir: '/bridge/dir/7' }));
  });
```

In `src/agent/docker/dockerRunner.test.ts`:
Add a test verifying that `prepareDockerSandbox` calls `seedAgyCredentials` for `antigravity` / `agy` when `bridgeDir` is provided:

```typescript
  it('calls seedAgyCredentials for antigravity when bridgeDir is set', async () => {
    const proc = fakeDockerProcess();
    const bridgeDir = mkdtempSync(join(tmpdir(), 'karst-bridge-test-'));
    const result = await prepareDockerSandbox({
      proc,
      core: 'antigravity',
      names,
      user: undefined,
      ticket,
      proxyScript: '/script/proxy.mjs',
      bridgeDir,
      temp,
    });
    expect(result.ok).toBe(true);
    expect(existsSync(join(bridgeDir, 'antigravity', 'gemini', 'antigravity-cli'))).toBe(true);
    rmSync(bridgeDir, { recursive: true, force: true });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- src/agent/docker/resolveDocker.test.ts src/agent/docker/dockerRunner.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

In `src/agent/docker/dockerRunner.ts`:
- Import `type DockerRunnerCore` from `./dockerImage.js`.
- Import `seedAgyCredentials` from `./dockerCredentials.js`.
- Update `DockerRunnerOptions.core: DockerRunnerCore`.
- Update `PrepareInput`:
  ```typescript
  export interface PrepareInput {
    readonly proc: DockerProcess;
    readonly core: DockerRunnerCore;
    readonly names: DockerNames;
    readonly user: LinuxUser | undefined;
    readonly ticket: SandboxTicketRef;
    readonly proxyScript: string;
    readonly opencode2Host?: { readonly command: string; readonly env: Readonly<Record<string, string>> };
    readonly bridgeDir?: string;
    readonly temp?: TempDirs;
    readonly debug?: (message: string) => void;
    readonly hostPorts?: readonly number[];
  }
  ```
- In `cloneAndSeed`:
  ```typescript
  async function cloneAndSeed(input: PrepareInput, ctx: CloneContext): Promise<StepResult> {
    const { proc, names } = input;
    let clone: StepResult;
    try {
      clone = await ensureClone(ctx, { hostWorktreePath: input.ticket.hostWorktreePath, branch: input.ticket.branch });
    } catch (err) {
      clone = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    if (!clone.ok) return clone;
    if (input.core === 'opencode2' && input.opencode2Host) {
      return seedOpencode2Credentials({
        proc, names, user: input.user,
        hostCommand: input.opencode2Host.command, hostEnv: input.opencode2Host.env,
        ...(input.debug ? { debug: input.debug } : {}),
      });
    }
    if ((input.core === 'antigravity' || input.core === 'agy') && input.bridgeDir) {
      return seedAgyCredentials({
        bridgeDir: input.bridgeDir,
        ...(input.debug ? { debug: input.debug } : {}),
      });
    }
    return { ok: true };
  }
  ```

In `src/agent/docker/resolveDocker.ts`:
- Import `type DockerRunnerCore` from `./dockerImage.js`.
- Update `DockerResolveInput`:
  ```typescript
  export interface DockerResolveInput {
    readonly core: string;
    readonly projectRoot: string;
    readonly ticketId: number;
    readonly worktree: SandboxTicketRef | undefined;
    readonly bridgeDir?: string;
    readonly deps?: DockerResolveDeps;
  }
  ```
- In `resolveDocker`, pass `bridgeDir` to `prepareDockerSandbox`:
  ```typescript
      const prepared = await (deps.prepare ?? prepareDockerSandbox)({
        proc, core: input.core as DockerRunnerCore, names, user, ticket: input.worktree,
        proxyScript: join(assetsDir, 'allowlist-proxy.mjs'),
        ...(input.bridgeDir !== undefined ? { bridgeDir: input.bridgeDir } : {}),
        ...(input.core === 'opencode2' ? { opencode2Host: (deps.opencode2Host ?? defaultOpencode2Host)() } : {}),
        ...(deps.debug ? { debug: deps.debug } : {}),
        ...(deps.hostPorts && deps.hostPorts.length > 0 ? { hostPorts: deps.hostPorts } : {}),
      });
  ```
  And in `createDockerSessionRunner`:
  ```typescript
      const runner = createDockerSessionRunner({
        proc, core: input.core as DockerRunnerCore, names, user, memory,
        ...(authFile ? { authFile } : {}),
        ...(input.bridgeDir ? { evidenceDir: input.bridgeDir } : {}),
      });
  ```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- src/agent/docker/resolveDocker.test.ts src/agent/docker/dockerRunner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/docker/dockerRunner.ts src/agent/docker/resolveDocker.ts src/agent/docker/dockerRunner.test.ts src/agent/docker/resolveDocker.test.ts
git commit -m "feat(docker): plumb DockerRunnerCore, bridgeDir, and seedAgyCredentials through runner and resolveDocker"
```

---

### Task 8: Full Verification: Typecheck, Unit Tests, and Docs Check

**Files:**
- All touched files across tasks 1-7.

**Interfaces:**
- Repository quality gates and invariants.

- [ ] **Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: PASS with 0 errors.

- [ ] **Step 2: Run all unit tests**

Run: `npm run test:unit`
Expected: PASS across the full test suite.

- [ ] **Step 3: Run documentation checks**

Run: `npm run docs:check`
Expected: PASS with no lint, index, or covers errors.

- [ ] **Step 4: Verify git status is clean**

Run: `git status`
Expected: Clean working tree, all changes committed.

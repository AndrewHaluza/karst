# Dynamic Model Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve Claude, Codex, and Antigravity model choices from provider CLIs, then a Karst JSON feed, then cache, and finally bundled fallbacks without breaking saved selections.

**Architecture:** A vscode-free catalog module owns validation, bundled data, feed parsing, provider loaders, and tier resolution. Extension activation starts one asynchronous refresh and injects the current provider-partitioned catalog into onboarding and Settings; views initially use bundled data and can be refreshed when discovery completes.

**Tech Stack:** TypeScript ESM, Node `child_process.spawn`, Node `fetch`, VS Code `Memento`, Vitest.

## Global Constraints

- Provider precedence is CLI → Karst JSON feed → last-known-good cache → bundled fallback.
- CLI and HTTP operations time out after 3 seconds and accept at most 256 KiB.
- Model IDs match `[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}`; labels are non-blank, at most 160 characters, and contain no control characters.
- Provider failures are isolated; no discovery path blocks the extension-host event loop.
- Existing ticket/default launch precedence and unknown custom-model compatibility remain unchanged.
- Production ESM imports use `.js` suffixes; testable logic must not import `vscode`.

---

### Task 1: Catalog contract, validation, bundled data, and feed asset

**Files:**
- Create: `src/agent/modelCatalog.ts`
- Create: `src/agent/modelCatalog.test.ts`
- Create: `model-catalog.json`
- Modify: `src/agent/models.ts`
- Modify: `src/agent/models.test.ts`

**Interfaces:**
- Produces: `ModelCatalog = Readonly<Record<AgentProvider, readonly ModelOption[]>>`
- Produces: `validateModelList(provider: AgentProvider, value: unknown): ModelOption[] | undefined`
- Produces: `parseModelFeed(value: unknown): Partial<ModelCatalog>`
- Produces: `bundledModelCatalog(): ModelCatalog`
- Produces: `isModelCompatibleWithProvider(provider, id, catalog?): boolean`
- Preserves: `modelsForProvider(provider, catalog?)` and `resolveModelForProvider(...)`

- [ ] **Step 1: Write failing validation and fallback tests**

Add focused cases proving valid normalization, rejection of blank/unsafe/duplicate/empty lists, independent feed sections, and non-empty bundled lists for all three providers:

```ts
expect(validateModelList('codex', [{ id: 'gpt-5.6-sol', label: ' GPT-5.6 Sol ' }]))
  .toEqual([{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', providers: ['codex'] }]);
expect(validateModelList('codex', [])).toBeUndefined();
expect(parseModelFeed({
  version: 1,
  providers: {
    claude: [{ id: 'opus', label: 'Opus (latest)' }],
    codex: [],
    antigravity: [{ id: 'bad id', label: 'Bad' }],
  },
})).toEqual({ claude: [{ id: 'opus', label: 'Opus (latest)', providers: ['claude'] }] });
for (const provider of ['claude', 'codex', 'antigravity'] as const) {
  expect(bundledModelCatalog()[provider].length).toBeGreaterThan(0);
}
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run src/agent/modelCatalog.test.ts src/agent/models.test.ts`

Expected: FAIL because the catalog module and Codex fallback do not exist.

- [ ] **Step 3: Implement the catalog contract and feed**

Implement provider-aware validation so returned `ModelOption.providers` is
exact. Move bundled entries behind `bundledModelCatalog`; add current usable
Codex choices and publish the same provider-partitioned entries in root
`model-catalog.json` with `"version": 1`. Keep `KNOWN_MODELS` as the flattened
bundled compatibility export, let `modelsForProvider` accept an optional
catalog, and export provider compatibility without changing the rule that an
unknown custom ID is compatible.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npx vitest run src/agent/modelCatalog.test.ts src/agent/models.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add model-catalog.json src/agent/modelCatalog.ts src/agent/modelCatalog.test.ts src/agent/models.ts src/agent/models.test.ts
git commit -m "feat: define dynamic model catalog contract"
```

### Task 2: Bounded asynchronous command execution and provider parsers

**Files:**
- Create: `src/agent/modelDiscovery.ts`
- Create: `src/agent/modelDiscovery.test.ts`

**Interfaces:**
- Produces: `DiscoveryResult = { status: 'available'; models: ModelOption[] } | { status: 'unavailable'; reason: string }`
- Produces: `discoverCodexModels(run?: CommandRunner): Promise<DiscoveryResult>`
- Produces: `discoverAntigravityModels(run?: CommandRunner): Promise<DiscoveryResult>`
- Produces: `discoverClaudeModels(): Promise<DiscoveryResult>`
- Produces: `makeCommandRunner(spawnImpl, limits?): CommandRunner`

- [ ] **Step 1: Write failing parser and runner tests**

Test Antigravity normalization from representative `agy models` text; test Codex JSON-lines handling of unrelated notifications followed by an `id: 2` `model/list` response; test missing commands, non-zero exits, timeout kill, output overflow, malformed protocol, and empty model lists as unavailable. Assert Claude reports an explicit unsupported reason without spawning.

```ts
expect(parseAntigravityModels([
  'Available models:',
  '  Gemini 3.6 Flash (High)',
  '  Claude Opus 5 (Thinking)',
].join('\n')).map((m) => m.id)).toEqual([
  'gemini-3.6-flash-high',
  'claude-opus-5-thinking',
]);
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run src/agent/modelDiscovery.test.ts`

Expected: FAIL because discovery functions do not exist.

- [ ] **Step 3: Implement bounded provider discovery**

Use `spawn` with `shell: false`, piped stdio, a 3-second timer, and a shared 256-KiB counter across stdout/stderr. For Codex, spawn `codex app-server --stdio`, write JSON-lines requests for `initialize` (`id: 1`), `initialized`, and `model/list` (`id: 2`), parse only the matching response, normalize `model`, `displayName`, and availability fields, then terminate. For Antigravity, run `agy models` and derive stable lower-kebab IDs from display names while preserving display labels. Validate every normalized result through Task 1's validator.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npx vitest run src/agent/modelDiscovery.test.ts`

Expected: PASS with fake children and no real provider process.

- [ ] **Step 5: Commit**

```bash
git add src/agent/modelDiscovery.ts src/agent/modelDiscovery.test.ts
git commit -m "feat: discover models from provider CLIs"
```

### Task 3: Feed loading, cache validation, and isolated tier resolution

**Files:**
- Create: `src/agent/modelCatalogLoader.ts`
- Create: `src/agent/modelCatalogLoader.test.ts`

**Interfaces:**
- Consumes: Task 1 validators and Task 2 discovery functions
- Produces: `CatalogCache` with `get(provider)` and `set(provider, entry)` methods
- Produces: `loadModelCatalog(deps): Promise<{ catalog: ModelCatalog; sources: Record<AgentProvider, CatalogSource> }>`
- Produces: `fetchModelFeed(fetchImpl, url?, limits?): Promise<Partial<ModelCatalog>>`

- [ ] **Step 1: Write failing tier and isolation tests**

Use injected CLI loaders, fetch, cache, and bundled catalog. Prove:

```ts
expect(result.sources).toEqual({
  claude: 'feed',
  codex: 'cli',
  antigravity: 'cache',
});
```

Also prove CLI beats feed, feed beats cache, cache beats bundled; invalid/empty feed sections fall through independently; HTTP error, timeout, oversized body, invalid JSON, non-HTTPS final URL, and unknown schema version fall through; only CLI/feed successes update their provider cache.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run src/agent/modelCatalogLoader.test.ts`

Expected: FAIL because loader functions do not exist.

- [ ] **Step 3: Implement feed and resolution**

Fetch `https://raw.githubusercontent.com/AndrewHaluza/karst/main/model-catalog.json` once with `AbortController`, stream or bounded-read the body to 256 KiB, verify `response.ok` and HTTPS final URL, then parse per provider. Start all CLI loaders concurrently with `Promise.allSettled`; resolve each provider independently through the four tiers. Cache entries contain `{ models, source, fetchedAt }`, and cache reads pass through the same validation.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npx vitest run src/agent/modelCatalogLoader.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/modelCatalogLoader.ts src/agent/modelCatalogLoader.test.ts
git commit -m "feat: resolve model catalog with layered fallback"
```

### Task 4: Host-supplied catalogs in onboarding and Settings

**Files:**
- Modify: `src/ui/onboarding/state.ts`
- Modify: `src/ui/onboarding/state.test.ts`
- Modify: `src/ui/onboarding/panel.ts`
- Modify: `src/ui/onboarding/panel.test.ts`
- Modify: `src/ui/settings/state.ts`
- Modify: `src/ui/settings/state.test.ts`
- Modify: `src/ui/settings/panel.ts`
- Modify: `src/ui/settings/panel.test.ts`
- Modify: `src/ui/settings/actions.ts`
- Modify: `src/ui/settings/actions.test.ts`
- Modify: `src/ui/settings/webview.html`
- Modify: `src/ui/settings/webview.test.ts`
- Modify: `src/ui/onboarding/webview.html`
- Modify: `src/ui/onboarding/webview.test.ts`

**Interfaces:**
- Consumes: `ModelCatalog`
- Produces: `SettingsState.models: ModelCatalog`
- Changes: `buildOnboardingState(..., modelCatalog?)`
- Changes: panel constructors accept `modelCatalog: () => ModelCatalog`
- Produces: picker helper behavior that includes absent saved values

- [ ] **Step 1: Write failing state and picker tests**

Assert onboarding uses an injected remote provider list. Assert Settings serializes all three provider lists. Assert Settings HTML contains no `const KNOWN_MODELS` mirror and filters `state.models[provider]`. Add webview behavior fixtures proving a missing saved default/ticket model is rendered as `Saved model: <id>` and is not cleared merely because it is absent from the current list.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run src/ui/onboarding/state.test.ts src/ui/onboarding/panel.test.ts src/ui/onboarding/webview.test.ts src/ui/settings/state.test.ts src/ui/settings/panel.test.ts src/ui/settings/actions.test.ts src/ui/settings/webview.test.ts`

Expected: FAIL because states and panels do not accept dynamic catalogs and Settings still uses its mirror.

- [ ] **Step 3: Thread catalog state through both views**

Add catalog getters to both panel managers and state builders, defaulting to `bundledModelCatalog()` to preserve existing callers. Settings state carries all providers; onboarding carries the current provider list. Remove the Settings HTML constant and render from host state. Before setting each select value, append an escaped saved option when the current value is non-blank and absent. Provider change continues to clear a model only when `isModelCompatibleWithProvider` identifies it as a known model for another provider; absence alone does not clear it.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npx vitest run src/ui/onboarding/state.test.ts src/ui/onboarding/panel.test.ts src/ui/onboarding/webview.test.ts src/ui/settings/state.test.ts src/ui/settings/panel.test.ts src/ui/settings/actions.test.ts src/ui/settings/webview.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/onboarding src/ui/settings
git commit -m "feat: render host-supplied model catalogs"
```

### Task 5: Activation refresh, VS Code cache adapter, and live view updates

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/ui/onboarding/panel.ts`
- Modify: `src/ui/onboarding/panel.test.ts`
- Modify: `src/ui/settings/panel.ts`
- Modify: `src/ui/settings/panel.test.ts`
- Create: `src/agent/modelCatalogCache.ts`
- Create: `src/agent/modelCatalogCache.test.ts`

**Interfaces:**
- Consumes: `loadModelCatalog`, panel catalog getters
- Produces: `makeMementoCatalogCache(memento): CatalogCache`
- Produces: `OnboardingManager.refreshModels()` and `SettingsManager.refreshModels()`

- [ ] **Step 1: Write failing cache and refresh tests**

Test the thin Memento adapter with a fake `{ get, update }`. In panel tests, open views with bundled state, change the catalog getter, call `refreshModels`, and assert every open panel receives fresh state while disposed panels receive nothing.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run src/agent/modelCatalogCache.test.ts src/ui/onboarding/panel.test.ts src/ui/settings/panel.test.ts`

Expected: FAIL because the cache adapter and refresh methods do not exist.

- [ ] **Step 3: Wire activation without delaying it**

At activation, initialize an in-memory catalog from `bundledModelCatalog()`, construct the Memento cache over `context.globalState`, and pass catalog getters to both managers. Start `void loadModelCatalog(...)`; on success replace the in-memory catalog and invoke both refresh methods. Catch and log only the unexpected top-level failure because normal provider failures are values handled by the loader. Do not await discovery before registering commands or views.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npx vitest run src/agent/modelCatalogCache.test.ts src/ui/onboarding/panel.test.ts src/ui/settings/panel.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extension.ts src/agent/modelCatalogCache.ts src/agent/modelCatalogCache.test.ts src/ui/onboarding/panel.ts src/ui/onboarding/panel.test.ts src/ui/settings/panel.ts src/ui/settings/panel.test.ts
git commit -m "feat: refresh model catalogs during activation"
```

### Task 6: Compatibility regression and complete verification

**Files:**
- Modify: `src/agent/models.test.ts`
- Modify: `src/ui/onboarding/state.test.ts`
- Modify: `src/ui/settings/webview.test.ts`
- Modify only if failures reveal a defect: files owned by Tasks 1–5

**Interfaces:**
- Verifies all prior task interfaces; produces no new production interface.

- [ ] **Step 1: Add final compatibility regressions**

Prove a saved supported model still launches, an unknown custom model remains valid, a known cross-provider model is dropped, an absent-but-saved model stays in both selectors, and each provider has a usable result when every dynamic source fails.

- [ ] **Step 2: Run focused model and UI suites**

Run: `npx vitest run src/agent/modelCatalog.test.ts src/agent/modelDiscovery.test.ts src/agent/modelCatalogLoader.test.ts src/agent/modelCatalogCache.test.ts src/agent/models.test.ts src/ui/onboarding src/ui/settings`

Expected: PASS.

- [ ] **Step 3: Run static and full verification**

Run: `npm run typecheck`

Run: `npm test`

Run: `npm run build`

Run: `git diff --check`

Expected: all commands exit 0.

- [ ] **Step 4: Request code review and address findings**

Use the required TypeScript/JavaScript code reviewer on the completed diff. For each valid finding, add a failing regression test, verify RED, apply the minimal fix, and rerun the focused suite.

- [ ] **Step 5: Commit final regressions or fixes**

```bash
git add src model-catalog.json
git commit -m "test: cover dynamic model catalog compatibility"
```

Skip this commit only when Task 6 produces no file changes.

- [ ] **Step 6: Record implementation completion**

Run the ticket-provided `karst stage impl pass` command only after the reviewer findings and all verification commands pass.

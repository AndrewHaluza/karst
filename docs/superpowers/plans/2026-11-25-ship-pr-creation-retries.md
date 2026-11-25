# Ship PR Creation Retries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship retries a `gh pr create` that fails with a GitHub server error, and adopts a PR that the failed call created.

**Architecture:** A pure classifier `isGitHubServerError` in `src/integrations/githubServerError.ts` holds a closed list of server-error patterns. A helper `openPrWithServerErrorRetry` in `src/workflow/stages/shipPushRecovery.ts` wraps `openPr`: on a server error it waits (injected `wait`), probes `findOpenPr`, adopts a found PR, else creates again. `ship.ts` calls the helper in place of `openPr`; the existing adopted branch does the backfill and the design-rule sync.

**Tech Stack:** TypeScript (ESM, `.js` import suffix), vitest.

**Spec:** ticket FIX-SHIP-PR-CREATION-RETRIES-A (`karst context FIX-SHIP-PR-CREATION-RETRIES-A`).

## Global Constraints

- Retry only the closed list: `HTTP 5\d\d`, `Something went wrong while executing your query`, `502 Bad Gateway`, `503 Service Unavailable`, `504 Gateway Time-?out`.
- `PR_SERVER_ERROR_RETRY_DELAYS_MS = [15_000, 45_000]` (3 attempts in total).
- A PR found by the probe is adopted, never re-created.
- Any other error, or the error of the last attempt, propagates unchanged.
- Progress detail text: `GitHub server error at PR creation, retry <n>/<max> in <s>s`.
- Out of scope: Autopilot retry, PR description reuse, UI text, push retry.

---

### Task 1: The classifier `isGitHubServerError`

**Files:**
- Create: `src/integrations/githubServerError.ts`
- Test: `src/integrations/githubServerError.test.ts`

**Interfaces:**
- Produces: `export const GITHUB_SERVER_ERROR_PATTERNS: readonly RegExp[]`, `export function isGitHubServerError(text: string): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { GITHUB_SERVER_ERROR_PATTERNS, isGitHubServerError } from './githubServerError.js';

describe('isGitHubServerError', () => {
  it.each([
    'GraphQL: Something went wrong while executing your query. Please include `ABC:123` when reporting this issue.',
    'HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)',
    '503 Service Unavailable',
    '504 Gateway Time-out',
  ])('is true for %s', (text) => expect(isGitHubServerError(text)).toBe(true));

  it.each([
    'a pull request for branch "x" into branch "y" already exists',
    'No commits between develop and karst/x',
    'HTTP 401: Bad credentials',
    'HTTP 422: Validation Failed',
    'could not run gh',
  ])('is false for %s', (text) => expect(isGitHubServerError(text)).toBe(false));

  it('exports a closed list of 5 patterns', () => {
    expect(GITHUB_SERVER_ERROR_PATTERNS).toHaveLength(5);
  });
});
```

- [ ] **Step 2: Run it and see it fail** — `npx vitest run src/integrations/githubServerError.test.ts` (module not found).

- [ ] **Step 3: Implement**

```ts
export const GITHUB_SERVER_ERROR_PATTERNS: readonly RegExp[] = [
  /HTTP 5\d\d\b/,
  /Something went wrong while executing your query/i,
  /502 Bad Gateway/i,
  /503 Service Unavailable/i,
  /504 Gateway Time-?out/i,
];

export function isGitHubServerError(text: string): boolean {
  return GITHUB_SERVER_ERROR_PATTERNS.some((p) => p.test(text));
}
```

- [ ] **Step 4: Run the test and see it pass.**
- [ ] **Step 5: Commit** — `feat: classify GitHub server errors from gh output`.

### Task 2: `openPrWithServerErrorRetry`

**Files:**
- Modify: `src/workflow/stages/shipPushRecovery.ts`
- Test: `src/workflow/stages/shipPushRecovery.test.ts`

**Interfaces:**
- Consumes: `isGitHubServerError` (Task 1), `openPr(gh, OpenPrOpts): Promise<CreatedPr>`, `findOpenPr(gh, cwd): Promise<ExistingPr | null>`.
- Produces: `export const PR_SERVER_ERROR_RETRY_DELAYS_MS: readonly number[]`, `export interface PrRetryDeps { wait(ms): Promise<void>; onRetry(n: number, max: number, delayMs: number): void }`, `export async function openPrWithServerErrorRetry(gh: GhRunner, opts: OpenPrOpts, deps: PrRetryDeps): Promise<CreatedPr>`.

- [ ] **Step 1: Write failing tests** with a scripted fake gh (`pr create` answers from a queue, `pr view` answers from a queue): (a) 502 twice then URL gives `adopted: false`, waits `[15000, 45000]`, `onRetry` calls `(1,2,15000)`, `(2,2,45000)`; (b) GraphQL error once, then `pr view` finds an OPEN PR gives `adopted: true`, one `pr create` only; (c) 3 server errors reject with the third error text; (d) `HTTP 422` rejects with no wait and no probe.
- [ ] **Step 2: Run** `npx vitest run src/workflow/stages/shipPushRecovery.test.ts` and see them fail.
- [ ] **Step 3: Implement**

```ts
export const PR_SERVER_ERROR_RETRY_DELAYS_MS: readonly number[] = [15_000, 45_000];

export async function openPrWithServerErrorRetry(gh, opts, deps) {
  const max = PR_SERVER_ERROR_RETRY_DELAYS_MS.length;
  try {
    return await openPr(gh, opts);
  } catch (first) {
    let last = first;
    for (const [i, delay] of PR_SERVER_ERROR_RETRY_DELAYS_MS.entries()) {
      if (!isGitHubServerError(errorText(last))) throw last;
      deps.onRetry(i + 1, max, delay);
      await deps.wait(delay);
      const found = await findOpenPr(gh, opts.cwd);
      if (found) return { url: found.url, number: found.number, adopted: true };
      try { return await openPr(gh, opts); } catch (err) { last = err; }
    }
    throw last;
  }
}
```

- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Commit** — `feat: retry gh pr create on a GitHub server error`.

### Task 3: Ship uses the retry, and the docs block

**Files:**
- Modify: `src/workflow/stages/ship.ts` (the `openPr` call in the `pr` step, near line 1834)
- Modify: `docs/arch/github-and-merge.md` (new `@arch:GH-10`, GH-00 rules line)
- Test: `src/workflow/stages/ship.integration.test.ts` (new `describe('GitHub server error at PR creation')`)

- [ ] **Step 1: Write failing ship tests:** 502 twice then URL (ship passes, one PR row, waits `[15000, 45000]`, 2 `pr` note events); GraphQL once then the probe finds the PR (no second `pr create`, PR adopted, empty body backfilled by `pr edit`); 3 server errors (ship rejects with the third text, the `pr` step is `failed`).
- [ ] **Step 2: Run** `npx vitest run src/workflow/stages/ship.integration.test.ts -t "server error at PR creation"` and see them fail.
- [ ] **Step 3: Replace the call** in `ship.ts`:

```ts
const created = await openPrWithServerErrorRetry(
  gh,
  { cwd: wt.path, title: prTitle, body, base, head: wt.branch ?? undefined },
  {
    wait: opts.wait ?? defaultWait,
    onRetry: (n, max, delayMs) =>
      onProgress({
        repo: wt.repo,
        step: 'pr',
        status: 'note',
        detail: `GitHub server error at PR creation, retry ${n}/${max} in ${delayMs / 1000}s`,
      }),
  },
);
```

- [ ] **Step 4: Add `@arch:GH-10`** with `covers: src/integrations/githubServerError.ts#isGitHubServerError, src/workflow/stages/shipPushRecovery.ts#openPrWithServerErrorRetry`, and add `@arch:GH-09 · @arch:GH-10` to the GH-00 rules line. Run `npm run -s docs:graph`, `npm run -s docs:index`, `npm run -s docs:covers`.
- [ ] **Step 5: Verify** — `npx vitest run` on the 3 test files, `npm run -s typecheck`.
- [ ] **Step 6: Commit** — `fix: ship retries PR creation on a GitHub server error and adopts a PR the failed call created`.

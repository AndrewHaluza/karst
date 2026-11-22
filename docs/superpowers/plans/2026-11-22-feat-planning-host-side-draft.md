# Host-side draft quality checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the planner short, deterministic, warn-only host warnings when a draft is inverted, duplicated, thin, oversized, leaks a session path, names a missing path or a wrong design key, or overlaps another open draft or ticket.

**Architecture:** A new pure module `src/planning/draftQualityChecks.ts` holds the text checks and the path extractor. `src/extension/ops/planningConstraintChecks.ts` gets the `@ui:KEY` check, one async `git cat-file --batch-check` per distinct `repoPath`, and the pure overlap check. A new store module `src/store/draftOverlap.ts` reads the overlap candidates with one light SQL query. `planningOutbox.ts` runs the sync checks in `quickWarnings` and the git path probe together with the commit probe under the one D782 `checking` latch.

**Tech Stack:** TypeScript (ESM, `.js` import suffix), vitest 4, better-sqlite3 store, `node:child_process` `execFile` (async only).

**Spec:** the ticket description of T1307 (`karst context FEAT-PLANNING-HOST-SIDE-DRAFT`, attachment `spilled-description.txt`) and its Context brief (D783). This plan copies every number from it.

## Global Constraints

- Every warning text is at most 60 chars (`MAX_WARNING_CHARS = 60`). A token in a warning (key, path, ref) is clipped with `clipToken`.
- Warn-only: no quality check ever rejects a draft (`@arch:DRAFT-CONSTRAINTS`).
- Zero `spawnSync`/`execFileSync` in `planningConstraintChecks.ts`, `planningOutbox.ts`, `extension.ts` (`src/context/hostGitFree.test.ts` checks this).
- At most 2 git processes for each distinct `repoPath` for the path check. This plan uses 1 (one `cat-file --batch-check`).
- At most 50 checked paths per draft. At most 3 missing-path warnings, then one `+N more missing paths at base` warning.
- At most 3 overlap warnings.
- The host never reads the content of an agent-writable scratch file back. `hasPlanArtifact` reads only the names in `<scratch>/artifacts`.
- Do NOT edit `src/ui/**` or visual baselines.
- No SQLite in `karst draft` (`@arch:CLI-13`). Nothing in this plan touches `src/cli/`.
- A new source file must reach a Stryker mutation score of 85 in CI. Each task writes boundary tests on both sides of each threshold.
- Commands: `npx vitest run <file>` for one unit file; add `--config vitest.integration.config.ts` for an `*.integration.test.ts` file. Run `npm run -s typecheck` once at the end of each task. If the better-sqlite3 ABI is wrong, run `npm run -s rebuild:node` first.

## Deviations from the spec (decided, with evidence)

1. **`@ui` key charset.** The spec anchor `/^@(arch|ui):([A-Z0-9_-]+)$/` and the claim "all 193 `@ui:` blocks match" are wrong for this repo. `grep -rhoE '^## \[@ui:[^]]+\]' docs/ui | sort -u` gives 256 keys. 206 match the strict class. 50 do not: numeric keys in `docs/ui/DESIGN-SYSTEM.md` (`@ui:1.1`, `@ui:11.12`) and lowercase suffixes (`@ui:UI-R09b`). With `[A-Za-z0-9._-]` all 256 match. Decision: `@arch:` keeps `[A-Z0-9_-]+` (the existing tests need a lowercase arch key to stay malformed). `@ui:` uses `[A-Za-z0-9._-]+`. Both stay bare-token anchored (`^…$`).
2. **Malformed-key text.** The spec text `malformed design key <c> (use bare @arch:KEY or @ui:KEY)` is 53 chars before `<c>`, so it breaks the 60-char cap. Decision: keep `malformed design key <clipToken(c, 39)>` (max 60 chars). The bare-key hint goes into `@arch:DRAFT-QUALITY`. The existing assertions in `planningConstraintChecks.test.ts` stay as they are.
3. **Base-ref resolution.** The spec resolves `origin/<base>` → `<base>` → `HEAD` with `rev-parse` before `cat-file`. A sequential fallback needs up to 3 `rev-parse` spawns, which breaks "at most 2 per repoPath". Decision: send `<ref>^{commit}` for all 3 refs and `<ref>:<path>` for all 3 refs in ONE `cat-file --batch-check` stdin, then use the first ref that resolves. That is 1 spawn for each repoPath.
4. **Overlap SQL.** The spec SQL uses `NOT IN ("done", "closed")`. better-sqlite3 reads double-quoted tokens as identifiers. Decision: bind `'done'` and `'closed'` as parameters.
5. **Generic root files in overlap.** `extractReferencedPaths` only returns paths under the repo roots (`src/`, `docs/`, …), so `package.json`, `AGENTS.md`, `CLAUDE.md`, `README.md`, `tsconfig.json` at the root never reach the overlap set. A filter for them would be dead code (a surviving mutant). Decision: filter only `docs/**` and `*.md`.
6. **Inverted vs duplicate.** The duplicate check runs only when the inverted check did not fire, so one draft never shows both callouts.

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/planning/draftQualityChecks.ts` | Create | Pure text checks, path extractor, `clipToken`, `jaccard`. No I/O. |
| `src/planning/draftQualityChecks.test.ts` | Create | Unit tests, P73 fixtures, every boundary. |
| `src/extension/ops/planningConstraintChecks.ts` | Modify | `@ui` keys, 60-char clipping, batched git path probe, `repoTargetsOf`, `overlapWarnings`. |
| `src/extension/ops/planningConstraintChecks.test.ts` | Modify | Unit tests for the items above (fake git batch). |
| `src/extension/ops/planningConstraintChecks.integration.test.ts` | Create | One real-git test of `gitCatFileBatch` + `missingPathWarnings`. |
| `src/store/planningProposals.ts` | Modify | Export `projectGraph` and `NEW_NODE` (2 words). |
| `src/store/draftOverlap.ts` | Create | `connectedNodes`, `listOverlapCandidates` (one light SQL query). |
| `src/store/draftOverlap.test.ts` | Create | Store tests with `openStore(':memory:')`. |
| `src/extension/ops/planningOutbox.ts` | Modify | New deps, `quickWarnings` with scratch and id, `verifyAsync` (one latch). |
| `src/extension/ops/planningOutbox.integration.test.ts` | Modify | New `good` fixture, 2 adjusted tests, new quality tests. |
| `src/extension.ts` | Modify | Wire `pathTargets` and `gitBatch` into `createPlanningOutbox` (~L7510). |
| `docs/arch/cli.md` | Modify | New block `@arch:DRAFT-QUALITY`; short edits to `@arch:DRAFT-CONSTRAINTS`, `@arch:CLI-17`. |
| `docs/arch/store-and-schema.md` | Modify | One sentence each in `@arch:PLANNING` and `@arch:PLANNING-DEPS`. |
| `docs/INDEX.md`, `docs/COVERS.json`, `docs/arch/system-map.md` | Regenerate | `npm run -s docs:index`, `npm run -s docs:covers`, `npm run -s docs:graph`. |

---

### Task 1: Pure draft quality checks

**Files:**
- Create: `src/planning/draftQualityChecks.ts`
- Test: `src/planning/draftQualityChecks.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export const MAX_WARNING_CHARS = 60`
  - `export function clipToken(token: string, max: number): string`
  - `export interface ReferencedPaths { existing: string[]; created: string[]; anyPathCount: number }`
  - `export function extractReferencedPaths(text: string): ReferencedPaths`
  - `export function jaccard<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number`
  - `export interface DraftText { description: string; summary: string; repos: readonly string[] }`
  - `export function draftQualityWarnings(p: DraftText, opts?: { hasPlanArtifact?: boolean }): string[]`
  - Warning constants: `LEAK_WARNING`, `DROPPED_PLAN_WARNING`, `INVERTED_WARNING`, `DUPLICATE_WARNING`, `NO_PATHS_WARNING`, `NO_VERIFICATION_WARNING`.

- [ ] **Step 1: Write the failing test**

Create `src/planning/draftQualityChecks.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  clipToken,
  draftQualityWarnings,
  extractReferencedPaths,
  jaccard,
  DROPPED_PLAN_WARNING,
  DUPLICATE_WARNING,
  INVERTED_WARNING,
  LEAK_WARNING,
  MAX_WARNING_CHARS,
  NO_PATHS_WARNING,
  NO_VERIFICATION_WARNING,
} from './draftQualityChecks.js';

/** `text` padded with ` z…` (no path, no verification word) to exactly `n` chars. */
const pad = (text: string, n: number): string => `${text} ${'z'.repeat(Math.max(0, n))}`.slice(0, n);
/** A unique 22-word line `w<k>x0 … w<k>x21` (about 130 chars). */
const line = (k: number): string => Array.from({ length: 22 }, (_, i) => `w${k}x${i}`).join(' ');

const CORE = 'Edit src/auth/session.ts. Verify with vitest.';
const WELL_DESC = pad(CORE, 200);
const WELL_SUM = pad('The login drops users when the token expires; renew it once.', 120);
const draft = (description: string, summary = WELL_SUM, repos: string[] = ['api']) => ({ description, summary, repos });

describe('clipToken', () => {
  it('keeps a short token and clips a long one from the front, keeping the tail', () => {
    expect(clipToken('abc', 3)).toBe('abc');
    expect(clipToken('abcd', 3)).toBe('…cd');
    expect(clipToken('src/very/long/path.ts', 8)).toBe('…path.ts');
    expect(clipToken('abcd', 3)).toHaveLength(3);
  });
});

describe('jaccard', () => {
  it('is |a∩b| / |a∪b|, and 0 for two empty sets', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3);
    expect(jaccard(new Set(['a']), new Set(['a']))).toBe(1);
    expect(jaccard(new Set(), new Set())).toBe(0);
  });
});

describe('extractReferencedPaths', () => {
  it('finds repo-relative paths under every root', () => {
    const roots = ['src', 'tests', 'scripts', 'docs', 'packages', 'lib', 'app', 'apps', 'cmd', 'internal', '.github'];
    const text = roots.map((r) => `${r}/x/file.ts`).join(' ');
    expect(extractReferencedPaths(text).existing).toEqual(roots.map((r) => `${r}/x/file.ts`));
  });
  it('strips URIs before matching', () => {
    const r = extractReferencedPaths('see https://github.com/o/r/blob/main/src/a.ts and file:///home/u/src/b.ts');
    expect(r).toEqual({ existing: [], created: [], anyPathCount: 0 });
  });
  it('does not match a root inside a longer path', () => {
    expect(extractReferencedPaths('/Users/me/src/a.ts foo/src/b.ts').existing).toEqual([]);
  });
  it('strips trailing punctuation, :line, #L anchors and a trailing slash', () => {
    const r = extractReferencedPaths('src/a.ts, src/b.ts. src/c.ts:12 src/d.ts:12:3 src/e.ts:10-20 src/f.ts#L10-L20 src/g/ (src/h.ts) `src/i.ts` **src/j.ts**');
    expect(r.existing).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts', 'src/g', 'src/h.ts', 'src/i.ts', 'src/j.ts']);
  });
  it('ignores globs and placeholders', () => {
    const r = extractReferencedPaths('src/**/*.ts src/a?.ts src/<name>.ts src/{a,b}.ts src/.../x.ts');
    expect(r).toEqual({ existing: [], created: [], anyPathCount: 0 });
  });
  it('dedupes and keeps the first order', () => {
    expect(extractReferencedPaths('src/b.ts src/a.ts src/b.ts').existing).toEqual(['src/b.ts', 'src/a.ts']);
  });
  it('counts root config files in anyPathCount only', () => {
    const r = extractReferencedPaths('package.json tsconfig.build.json Dockerfile Makefile ci.yml compose.yaml');
    expect(r.existing).toEqual([]);
    expect(r.anyPathCount).toBe(6);
  });
  it('does not count a config name that is part of a path twice', () => {
    expect(extractReferencedPaths('.github/workflows/ci.yml').anyPathCount).toBe(1);
  });
  it('classifies a path as created by a same-line marker', () => {
    for (const marker of ['[NEW]', '(new)', 'new file', 'Create ', 'creating ', 'add ']) {
      const r = extractReferencedPaths(`${marker} src/n.ts\nedit src/e.ts`);
      expect(r.created, marker).toEqual(['src/n.ts']);
      expect(r.existing, marker).toEqual(['src/e.ts']);
    }
  });
  it('classifies paths under a "New files" heading as created until the next heading', () => {
    const r = extractReferencedPaths('### New files\n- src/n.ts\n## Changes\n- src/c.ts');
    expect(r.created).toEqual(['src/n.ts']);
    expect(r.existing).toEqual(['src/c.ts']);
    expect(extractReferencedPaths('# New file\nsrc/one.ts').created).toEqual(['src/one.ts']);
  });
  it('a path that is created anywhere is never existing', () => {
    const r = extractReferencedPaths('[NEW] src/n.ts\nthen edit src/n.ts');
    expect(r).toEqual({ existing: [], created: ['src/n.ts'], anyPathCount: 1 });
  });
});

describe('draftQualityWarnings', () => {
  it('is silent for a well-formed draft', () => {
    expect(draftQualityWarnings(draft(WELL_DESC))).toEqual([]);
  });

  describe('session path leak', () => {
    const leaks = [
      '$KARST_ARTIFACTS/plan.md',
      '${KARST_ARTIFACTS}/plan.md',
      'planning-scratch/17/artifacts/plan.md',
      'globalStorage/karst.karst/planning-scratch/x/artifacts/p.md',
      '/tmp/abc/artifacts/plan.md',
      '/private/tmp/abc/artifacts/plan.md',
      '~/.gemini/antigravity/brain/123/plan.md',
      '~/.claude/plans/plan.md',
      '~/.claude/projects/-Users-me/memory/x.md',
      '~/.codex/sessions/x.md',
      '$HOME/.codex/x.md',
      '/Users/me/.codex/x.md',
      '/home/me/.codex/x.md',
      '.opencode/plans/p.md',
      'docs/superpowers/plans/2026-01-01-x.md',
    ];
    it.each(leaks)('flags %s in the description', (leak) => {
      expect(draftQualityWarnings(draft(`${WELL_DESC} ${leak}`))).toContain(LEAK_WARNING);
    });
    it('flags a leak in the summary too', () => {
      expect(draftQualityWarnings(draft(WELL_DESC, `${WELL_SUM} ~/.claude/plans/p.md`))).toContain(LEAK_WARNING);
    });
    it.each(['docs/artifacts/spec.md', 'src/artifacts/x.ts', '.codex/config.toml', 'my.claude/plans/x'])('does not flag %s', (ok) => {
      expect(draftQualityWarnings(draft(`${WELL_DESC} ${ok}`))).not.toContain(LEAK_WARNING);
    });
  });

  describe('thin description', () => {
    it('warns below 120 chars, not at 120', () => {
      expect(draftQualityWarnings(draft(pad(CORE, 119)))).toContain('description is short (119 chars)');
      expect(draftQualityWarnings(draft(pad(CORE, 120))).some((w) => w.startsWith('description is short'))).toBe(false);
    });
  });

  describe('dropped plan artifact', () => {
    const noVerify = 'Edit src/auth/session.ts.';
    it('needs hasPlanArtifact', () => {
      expect(draftQualityWarnings(draft(pad(CORE, 299)))).not.toContain(DROPPED_PLAN_WARNING);
    });
    it('warns below 300 chars, not at 300 when the draft has paths and verification', () => {
      expect(draftQualityWarnings(draft(pad(CORE, 299)), { hasPlanArtifact: true })).toContain(DROPPED_PLAN_WARNING);
      expect(draftQualityWarnings(draft(pad(CORE, 300)), { hasPlanArtifact: true })).not.toContain(DROPPED_PLAN_WARNING);
    });
    it('warns below 500 chars without verification or without paths, not at 500', () => {
      expect(draftQualityWarnings(draft(pad(noVerify, 499)), { hasPlanArtifact: true })).toContain(DROPPED_PLAN_WARNING);
      expect(draftQualityWarnings(draft(pad('Verify with vitest.', 499)), { hasPlanArtifact: true })).toContain(DROPPED_PLAN_WARNING);
      expect(draftQualityWarnings(draft(pad(CORE, 499)), { hasPlanArtifact: true })).not.toContain(DROPPED_PLAN_WARNING);
      expect(draftQualityWarnings(draft(pad(noVerify, 500)), { hasPlanArtifact: true })).not.toContain(DROPPED_PLAN_WARNING);
    });
    it('does not stack on a thin description', () => {
      const w = draftQualityWarnings(draft(pad(CORE, 100)), { hasPlanArtifact: true });
      expect(w).toContain('description is short (100 chars)');
      expect(w).not.toContain(DROPPED_PLAN_WARNING);
    });
  });

  describe('inverted description and summary', () => {
    it('P73 Step 213: the plan sits in the summary', () => {
      const description = pad('Return the host warnings to the planner so that it can revise its draft before the review.', 160);
      const summary = [
        '1. Edit src/cli/draftCommand.ts to poll the index until checking clears.',
        '2. Edit src/extension/ops/planningOutbox.ts to write one rejection file per uuid.',
        '3. Add tests in src/cli/draftCommand.test.ts and run npx vitest run.',
        '4. Update docs/arch/cli.md and run npm run -s docs:check.',
      ].join('\n');
      expect(draftQualityWarnings(draft(description, summary))).toContain(INVERTED_WARNING);
    });
    it('branch 1: a longer summary (> 1.5x) and a description with no path', () => {
      const description = pad('Verify with vitest.', 200);
      expect(draftQualityWarnings(draft(description, pad('Long summary.', 301)))).toContain(INVERTED_WARNING);
      expect(draftQualityWarnings(draft(description, pad('Long summary.', 300)))).not.toContain(INVERTED_WARNING);
    });
    it('branch 1: numbered steps in the summary only, even when the description has a path', () => {
      const steps = pad('1. one\n2. two\n', 301);
      expect(draftQualityWarnings(draft(WELL_DESC, steps))).toContain(INVERTED_WARNING);
      expect(draftQualityWarnings(draft(`${WELL_DESC}\n1. a\n2. b`, steps))).not.toContain(INVERTED_WARNING);
      expect(draftQualityWarnings(draft(WELL_DESC, pad('1. one only', 301)))).not.toContain(INVERTED_WARNING);
      expect(draftQualityWarnings(draft(WELL_DESC, pad('Step 1 one\nStep 2 two', 301)))).toContain(INVERTED_WARNING);
    });
    it('branch 1: only while the description is below 1000 chars', () => {
      const d999 = pad('Verify with vitest.', 999);
      const d1000 = pad('Verify with vitest.', 1000);
      expect(draftQualityWarnings(draft(d999, pad('s', 1499)))).toContain(INVERTED_WARNING);
      expect(draftQualityWarnings(draft(d1000, pad('s', 1501)))).not.toContain(INVERTED_WARNING);
    });
    it('branch 2: two paths in the summary and none in the description', () => {
      const description = pad('Verify with vitest.', 200);
      expect(draftQualityWarnings(draft(description, pad('Edit src/a.ts and src/b.ts.', 120)))).toContain(INVERTED_WARNING);
      expect(draftQualityWarnings(draft(description, pad('Edit src/a.ts only.', 120)))).not.toContain(INVERTED_WARNING);
      expect(draftQualityWarnings(draft(pad('Verify with vitest.', 1000), pad('Edit src/a.ts and src/b.ts.', 120)))).not.toContain(INVERTED_WARNING);
    });
  });

  describe('duplicate description and summary', () => {
    it('P73 Step 226: the same body twice', () => {
      const body = pad(`${CORE}\n${line(1)}\n${line(2)}\n${line(3)}`, 520);
      expect(draftQualityWarnings(draft(body, body))).toContain(DUPLICATE_WARNING);
    });
    it('an exact match after normalization, at any length', () => {
      expect(draftQualityWarnings(draft(WELL_DESC, `  ${WELL_DESC.toUpperCase()}  `))).toContain(DUPLICATE_WARNING);
    });
    it('containment needs both texts at 400 chars or more', () => {
      const d400 = pad(CORE, 400);
      expect(draftQualityWarnings(draft(d400, `${d400} more words here`))).toContain(DUPLICATE_WARNING);
      const d399 = pad(CORE, 399);
      expect(draftQualityWarnings(draft(d399, `${d399} more words here`))).not.toContain(DUPLICATE_WARNING);
    });
    it('line Jaccard at 0.75 or more warns, below does not', () => {
      const description = `${CORE}\n${line(1)}\n${line(2)}\n${line(3)}`;
      // {CORE, L1, L2, L3} vs {L3, L2, L1, CORE, L9}: 4/5 = 0.8
      expect(draftQualityWarnings(draft(description, `${line(3)}\n${line(2)}\n${line(1)}\n${CORE}\n${line(9)}`))).toContain(DUPLICATE_WARNING);
      // {CORE, L1, L2, L3} vs {L3, L2, L1, L9}: 3/5 = 0.6
      expect(draftQualityWarnings(draft(description, `${line(3)}\n${line(2)}\n${line(1)}\n${line(9)}`))).not.toContain(DUPLICATE_WARNING);
    });
    it('line Jaccard of exactly 0.75 warns', () => {
      const description = `${line(1)}\n${line(2)}\n${line(3)}\n${CORE}`;
      // {L1, L2, L3, CORE} vs {CORE, L3, L2, L1}: needs one extra on one side for 3/4.
      const summary = `${line(3)}\n${line(2)}\n${line(1)}`;
      // {L1, L2, L3, CORE} vs {L3, L2, L1}: 3/4 = 0.75
      expect(draftQualityWarnings(draft(description, summary))).toContain(DUPLICATE_WARNING);
    });
    it('4-word shingle Jaccard catches a reflowed copy', () => {
      const words = Array.from({ length: 90 }, (_, i) => `word${i}`);
      const description = `${CORE}\n${words.join(' ')}`;
      const summary = words.slice(0, 60).join('\n') + ' ' + words.slice(60).join(' ') + ` ${CORE}`;
      expect(draftQualityWarnings(draft(description, summary))).toContain(DUPLICATE_WARNING);
    });
    it('does not stack on an inverted draft', () => {
      const description = pad('Verify with vitest.', 400);
      const w = draftQualityWarnings(draft(description, `${description} ${'q'.repeat(300)}`));
      expect(w).toContain(INVERTED_WARNING);
      expect(w).not.toContain(DUPLICATE_WARNING);
    });
  });

  describe('thin summary', () => {
    it('warns below 80 chars, not at 80', () => {
      expect(draftQualityWarnings(draft(WELL_DESC, pad('Short.', 79)))).toContain('summary is short (79 chars)');
      expect(draftQualityWarnings(draft(WELL_DESC, pad('Short.', 80))).some((w) => w.startsWith('summary is short'))).toBe(false);
    });
  });

  describe('missing paths and verification', () => {
    const noPath = pad('Verify with vitest.', 200);
    const noVerify = pad('Edit src/auth/session.ts.', 200);
    it('warns on no path and on no verification for a draft with repos', () => {
      expect(draftQualityWarnings(draft(noPath))).toContain(NO_PATHS_WARNING);
      expect(draftQualityWarnings(draft(noVerify))).toContain(NO_VERIFICATION_WARNING);
    });
    it('a root config file counts as a path', () => {
      expect(draftQualityWarnings(draft(pad('Edit package.json. Verify with vitest.', 200)))).not.toContain(NO_PATHS_WARNING);
    });
    it('stays silent for a draft with no repos', () => {
      const w = draftQualityWarnings(draft(pad('Research spike only.', 200), WELL_SUM, []));
      expect(w).not.toContain(NO_PATHS_WARNING);
      expect(w).not.toContain(NO_VERIFICATION_WARNING);
    });
    it.each(['test', 'tests', 'vitest', 'jest', 'pytest', 'playwright', 'spec', 'verify', 'verification', 'assert', 'acceptance', 'done when', 'typecheck', 'gate', 'lint', 'build', 'compile', 'confirm', 'reproduce', 'smoke'])(
      'accepts "%s" as verification',
      (word) => {
        expect(draftQualityWarnings(draft(pad(`Edit src/a.ts. ${word.toUpperCase()} it.`, 200)))).not.toContain(NO_VERIFICATION_WARNING);
      },
    );
    it('does not match a verification word inside another word', () => {
      expect(draftQualityWarnings(draft(pad('Edit src/a.ts. Contested rebuilding.', 200)))).toContain(NO_VERIFICATION_WARNING);
    });
    it('skips both on a thin description and on an inverted draft', () => {
      const thin = draftQualityWarnings(draft(pad('Short.', 100)));
      expect(thin).not.toContain(NO_PATHS_WARNING);
      expect(thin).not.toContain(NO_VERIFICATION_WARNING);
      const inverted = draftQualityWarnings(draft(pad('Short text.', 200), pad('Edit src/a.ts and src/b.ts.', 400)));
      expect(inverted).toContain(INVERTED_WARNING);
      expect(inverted).not.toContain(NO_PATHS_WARNING);
      expect(inverted).not.toContain(NO_VERIFICATION_WARNING);
    });
    it('skips the path warning, not the verification warning, when the plan artifact was dropped', () => {
      const w = draftQualityWarnings(draft(pad('Short text.', 200)), { hasPlanArtifact: true });
      expect(w).toContain(DROPPED_PLAN_WARNING);
      expect(w).not.toContain(NO_PATHS_WARNING);
      expect(w).toContain(NO_VERIFICATION_WARNING);
    });
  });

  describe('oversized description', () => {
    it('warns above 12000 chars, not at 12000', () => {
      expect(draftQualityWarnings(draft(pad(CORE, 12_001)))).toContain('description is very large (12001 chars; split draft)');
      expect(draftQualityWarnings(draft(pad(CORE, 12_000))).some((w) => w.startsWith('description is very large'))).toBe(false);
    });
  });

  it('every warning is at most 60 chars', () => {
    const worst = draftQualityWarnings(
      { description: `${'x'.repeat(32 * 1024 - 40)} ~/.claude/plans/p.md`, summary: 's', repos: ['api'] },
      { hasPlanArtifact: true },
    );
    const thin = draftQualityWarnings({ description: 'd', summary: 's', repos: ['api'] }, { hasPlanArtifact: true });
    for (const w of [...worst, ...thin, LEAK_WARNING, DROPPED_PLAN_WARNING, INVERTED_WARNING, DUPLICATE_WARNING, NO_PATHS_WARNING, NO_VERIFICATION_WARNING]) {
      expect(w.length, w).toBeLessThanOrEqual(MAX_WARNING_CHARS);
    }
  });
});
```

Note for the implementer: the test "line Jaccard of exactly 0.75" has a stray comment line; delete the first comment line (`// {L1, L2, L3, CORE} vs {CORE, L3, L2, L1}: …`) when you paste. The second comment is the true one. The shingle test: the reflowed summary has the same 90 words in the same order plus `CORE` at the end; the description has `CORE` at the start. Line Jaccard is low (the line breaks differ); shingle Jaccard is about 87/95 ≥ 0.75. If the test fails, print `jaccard` of the two shingle sets and adjust only the test data, not the threshold.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/planning/draftQualityChecks.test.ts`
Expected: FAIL with `Failed to resolve import "./draftQualityChecks.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/planning/draftQualityChecks.ts`:

```ts
/**
 * Pure, zero-I/O quality checks of a planning draft (`@arch:DRAFT-QUALITY`).
 * Every check is a WARNING, never a rejection (`@arch:DRAFT-CONSTRAINTS`), and
 * every warning is at most MAX_WARNING_CHARS long so the sidebar card stays on
 * one line. The checks cascade so that one draft does not stack callouts that
 * say the same thing.
 */

export const MAX_WARNING_CHARS = 60;
export const THIN_DESCRIPTION_CHARS = 120;
export const PLAN_ARTIFACT_SHORT_CHARS = 300;
export const PLAN_ARTIFACT_THIN_CHARS = 500;
export const INVERSION_RATIO = 1.5;
export const INVERSION_MAX_DESCRIPTION = 1000;
export const INVERSION_MIN_SUMMARY_PATHS = 2;
export const DUPLICATE_MIN_CHARS = 400;
export const DUPLICATE_SIMILARITY = 0.75;
export const THIN_SUMMARY_CHARS = 80;
export const OVERSIZED_DESCRIPTION_CHARS = 12_000;
const SHINGLE_WORDS = 4;
const MIN_NUMBERED_STEPS = 2;

export const LEAK_WARNING = 'draft references session/agent plan path (inline it)';
export const DROPPED_PLAN_WARNING = 'session has plan artifact but description is short';
export const INVERTED_WARNING = 'plan details in summary instead of description';
export const DUPLICATE_WARNING = 'description and summary duplicate each other';
export const NO_PATHS_WARNING = 'no repo file paths named in description';
export const NO_VERIFICATION_WARNING = 'no test or verification plan in description';

export interface DraftText {
  description: string;
  summary: string;
  repos: readonly string[];
}

export interface ReferencedPaths {
  /** Paths the draft edits: they must exist at the planned base. */
  existing: string[];
  /** Paths the draft creates (`[NEW]`, `add `, a "New files" heading): never checked. */
  created: string[];
  /** Distinct repo paths plus root config/build files: "does the draft name a file at all". */
  anyPathCount: number;
}

/** `token` cut to `max` chars; a long one keeps its tail (the file name) behind `…`. */
export function clipToken(token: string, max: number): string {
  return token.length <= max ? token : `…${token.slice(token.length - (max - 1))}`;
}

export function jaccard<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  let shared = 0;
  for (const x of a) if (b.has(x)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

const URI = /\b(?:https?|file):\/\/\S+/g;
const PATH_ROOTS = '(?:\\.github|src|tests|scripts|docs|packages|lib|app|apps|cmd|internal)';
/** A root at a token start (not inside `foo/src/…`), then everything up to a delimiter. */
const RAW_PATH = new RegExp(`(?<![\\w./-])${PATH_ROOTS}\\/[^\\s\`'"()\\[\\],;|]*`, 'g');
const ROOT_FILE = /(?<![\w./-])(?:package\.json|tsconfig[\w.-]*\.json|Dockerfile|Makefile|[\w.-]+\.ya?ml)(?![\w./-])/g;
const GLOB = /[*?<>{}]|\.\.\./;
const TRAILING = /[.,:;!?*/]+$/;
const LINE_SUFFIX = /:\d+(?:[-:]\d+)*$/;
const CREATED_MARKER = /\[NEW\]|\(new\)|\bnew file\b|\bcreate |\bcreating |\badd /i;
const HEADING = /^\s{0,3}#{1,6}\s/;
const NEW_FILES_HEADING = /\bnew files?\b/i;

/** The cleaned path of one raw match, or undefined for a glob, a placeholder or a bare root. */
function cleanPath(raw: string): string | undefined {
  const noAnchor = raw.split('#')[0]!;
  const path = noAnchor.replace(TRAILING, '').replace(LINE_SUFFIX, '').replace(TRAILING, '');
  if (GLOB.test(path)) return undefined;
  const slash = path.indexOf('/');
  return slash > 0 && slash < path.length - 1 ? path : undefined;
}

export function extractReferencedPaths(text: string): ReferencedPaths {
  const created = new Set<string>();
  const seen = new Set<string>();
  let rootFiles = 0;
  let inNewSection = false;
  for (const line of text.replace(URI, ' ').split('\n')) {
    if (HEADING.test(line)) inNewSection = NEW_FILES_HEADING.test(line);
    const isCreated = inNewSection || CREATED_MARKER.test(line);
    for (const m of line.matchAll(RAW_PATH)) {
      const path = cleanPath(m[0]);
      if (!path) continue;
      seen.add(path);
      if (isCreated) created.add(path);
    }
    rootFiles += [...line.matchAll(ROOT_FILE)].length;
  }
  const all = [...seen];
  return {
    existing: all.filter((p) => !created.has(p)),
    created: all.filter((p) => created.has(p)),
    anyPathCount: all.length + rootFiles,
  };
}

const LEAK_PATTERNS: readonly RegExp[] = [
  /\$\{?KARST_ARTIFACTS\b/,
  /planning-scratch\/[^/\s]+\/artifacts\b/,
  /globalStorage\/\S*?\/artifacts\b/,
  /(?:^|[\s'"`(=])\/(?:private\/)?tmp\/\S*?\/artifacts\b/m,
  /\.gemini\/\S*?\/brain\//,
  /(?<![\w.-])\.claude\/plans\//,
  /\.claude\/projects\/\S*?\/memory\//,
  /(?:~|\$HOME|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/\.codex\//,
  /(?<![\w.-])\.opencode\/plans\//,
  /(?<![\w./-])docs\/superpowers\/plans\//,
];

const VERIFICATION =
  /\b(?:test|tests|vitest|jest|pytest|playwright|spec|verify|verification|assert|acceptance|done when|typecheck|gate|lint|build|compile|confirm|reproduce|smoke)\b/i;
const NUMBERED_STEP = /^\s*(?:\d+[.)]|step\s+\d+\b)/i;

function hasNumberedSteps(text: string): boolean {
  return text.split('\n').filter((l) => NUMBERED_STEP.test(l)).length >= MIN_NUMBERED_STEPS;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s/._-]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function shingles(norm: string): Set<string> {
  const words = norm.split(' ').filter(Boolean);
  if (words.length < SHINGLE_WORDS) return new Set([words.join(' ')]);
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE_WORDS <= words.length; i += 1) out.add(words.slice(i, i + SHINGLE_WORDS).join(' '));
  return out;
}

function lineSet(text: string): Set<string> {
  return new Set(text.split('\n').map(normalize).filter(Boolean));
}

function isDuplicate(desc: string, sum: string): boolean {
  const nd = normalize(desc);
  const ns = normalize(sum);
  if (nd.length > 0 && nd === ns) return true;
  if (desc.length < DUPLICATE_MIN_CHARS || sum.length < DUPLICATE_MIN_CHARS) return false;
  if (nd.includes(ns) || ns.includes(nd)) return true;
  return Math.max(jaccard(shingles(nd), shingles(ns)), jaccard(lineSet(desc), lineSet(sum))) >= DUPLICATE_SIMILARITY;
}

function isInverted(desc: string, sum: string, descPaths: ReferencedPaths, sumPaths: ReferencedPaths): boolean {
  if (desc.length >= INVERSION_MAX_DESCRIPTION) return false;
  const longerSummary =
    sum.length > desc.length * INVERSION_RATIO &&
    (descPaths.anyPathCount === 0 || (hasNumberedSteps(sum) && !hasNumberedSteps(desc)));
  const pathsInSummary = sumPaths.anyPathCount >= INVERSION_MIN_SUMMARY_PATHS && descPaths.anyPathCount === 0;
  return longerSummary || pathsInSummary;
}

export function draftQualityWarnings(p: DraftText, opts: { hasPlanArtifact?: boolean } = {}): string[] {
  const desc = p.description;
  const sum = p.summary;
  const descPaths = extractReferencedPaths(desc);
  const sumPaths = extractReferencedPaths(sum);
  const verified = VERIFICATION.test(desc);
  const out: string[] = [];
  if (LEAK_PATTERNS.some((re) => re.test(`${desc}\n${sum}`))) out.push(LEAK_WARNING);
  const thin = desc.length < THIN_DESCRIPTION_CHARS;
  if (thin) out.push(`description is short (${desc.length} chars)`);
  const dropped =
    !thin &&
    opts.hasPlanArtifact === true &&
    (desc.length < PLAN_ARTIFACT_SHORT_CHARS ||
      (desc.length < PLAN_ARTIFACT_THIN_CHARS && (descPaths.anyPathCount === 0 || !verified)));
  if (dropped) out.push(DROPPED_PLAN_WARNING);
  const inverted = isInverted(desc, sum, descPaths, sumPaths);
  if (inverted) out.push(INVERTED_WARNING);
  else if (isDuplicate(desc, sum)) out.push(DUPLICATE_WARNING);
  if (sum.length < THIN_SUMMARY_CHARS) out.push(`summary is short (${sum.length} chars)`);
  const coded = p.repos.length > 0;
  if (coded && !thin && !dropped && !inverted && descPaths.anyPathCount === 0) out.push(NO_PATHS_WARNING);
  if (coded && !thin && !inverted && !verified) out.push(NO_VERIFICATION_WARNING);
  if (desc.length > OVERSIZED_DESCRIPTION_CHARS) out.push(`description is very large (${desc.length} chars; split draft)`);
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/planning/draftQualityChecks.test.ts`
Expected: PASS. If a fixture test fails, check the fixture arithmetic first (lengths from `pad`, Jaccard counts in the comments). Change the test data only when the arithmetic in the comment is wrong. Do not change a threshold.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run -s typecheck`
Expected: exit 0.

```bash
git add src/planning/draftQualityChecks.ts src/planning/draftQualityChecks.test.ts
git commit -m "feat(planning): pure draft quality checks with 60-char warnings"
```

---

### Task 2: `@ui:KEY` design keys and 60-char clipping of constraint warnings

**Files:**
- Modify: `src/extension/ops/planningConstraintChecks.ts` (`archKeysOf`, `archDocFiles`, `archWarnings`)
- Test: `src/extension/ops/planningConstraintChecks.test.ts`

**Interfaces:**
- Consumes: `clipToken`, `MAX_WARNING_CHARS` from `src/planning/draftQualityChecks.ts` (Task 1).
- Produces: unchanged signatures `archWarnings(constraints, repoPaths, debug): string[]` and `archDocFiles(constraints, repoPaths): Record<string, string>`, now for `@arch:KEY` (in `docs/arch/*.md`) AND `@ui:KEY` (in `docs/ui/*.md`). `sensitivePathWarning` is unchanged: only a well-formed `@arch:KEY` is a citation.

- [ ] **Step 1: Write the failing tests**

In `src/extension/ops/planningConstraintChecks.test.ts`, add a helper under `repoWithDocs` and a new `describe`:

```ts
function repoWithUiDocs(doc: string): string {
  const root = repoWithDocs(undefined);
  mkdirSync(join(root, 'docs', 'ui'), { recursive: true });
  writeFileSync(join(root, 'docs', 'ui', 'UI-INVARIANTS.md'), doc);
  return root;
}

describe('@ui design keys', () => {
  const uiDoc = '## [@ui:TITLE-KEY] T\n## [@ui:1.1] N\n## [@ui:UI-R09b] R\n';
  it('verifies @ui keys against docs/ui, including dotted and lowercase-suffix keys', () => {
    const repo = repoWithUiDocs(uiDoc);
    expect(archWarnings(['@ui:TITLE-KEY', '@ui:1.1', '@ui:UI-R09b', '@ui:NOPE'], [repo], vi.fn())).toEqual([
      'unknown design key @ui:NOPE',
    ]);
  });
  it('does not accept an @ui key from docs/arch or an @arch key from docs/ui', () => {
    const repo = repoWithUiDocs('## [@ui:ONLYUI] x\n');
    mkdirSync(join(repo, 'docs', 'arch'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'arch', 'a.md'), '## [@arch:ONLYARCH] x\n');
    expect(archWarnings(['@ui:ONLYARCH', '@arch:ONLYUI'], [repo], vi.fn())).toEqual([
      'unknown design key @ui:ONLYARCH',
      'unknown design key @arch:ONLYUI',
    ]);
  });
  it('flags a malformed @ui key and keeps @arch strict', () => {
    expect(archWarnings(['@ui:', '@ui:a b', '@arch:1.1', '@arch:x'], [], vi.fn())).toEqual([
      'malformed design key @ui:',
      'malformed design key @ui:a b',
      'malformed design key @arch:1.1',
      'malformed design key @arch:x',
    ]);
  });
  it('skips @ui keys with a debug line when no repo has docs/ui, and still checks @arch keys', () => {
    const debug = vi.fn();
    const repo = repoWithDocs('## [@arch:A] t\n');
    expect(archWarnings(['@ui:X', '@arch:A', '@arch:B'], [repo], debug)).toEqual(['unknown design key @arch:B']);
    expect(debug).toHaveBeenCalledWith(expect.stringMatching(/^\[planning\] .*docs\/ui.*@ui keys not verified/));
  });
  it('archDocFiles names the docs/ui file of an @ui key', () => {
    const repo = repoWithUiDocs(uiDoc);
    expect(archDocFiles(['@ui:1.1', '@ui:NOPE', 'free text'], [repo])).toEqual({ '@ui:1.1': 'UI-INVARIANTS.md' });
  });
  it('an @ui citation does not count for the prompt-sensitive check', () => {
    expect(sensitivePathWarning({ description: 'src/agent/seed.ts', summary: '', constraints: ['@ui:TITLE-KEY'] })).toHaveLength(1);
  });
  it('clips every design-key warning to 60 chars', () => {
    const long = `@arch:${'A'.repeat(190)}`;
    const bad = `@arch:${'a'.repeat(190)}`;
    const w = archWarnings([long, bad], [repoWithDocs('## [@arch:Z] t\n')], vi.fn());
    expect(w).toHaveLength(2);
    for (const x of w) expect(x.length).toBeLessThanOrEqual(60);
    expect(w[0]).toMatch(/^malformed design key …a+$/);
    expect(w[1]).toMatch(/^unknown design key …A+$/);
  });
});
```

The `malformed` warnings come first, then the `unknown` ones (the existing order). Keep the existing assertions at lines ~131, ~161 and ~162 unchanged (Deviation 2).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/extension/ops/planningConstraintChecks.test.ts`
Expected: FAIL — the `@ui` tests get `[]` or wrong items (`@ui:` is not checked yet), and the clip test gets a warning longer than 60 chars.

- [ ] **Step 3: Write the implementation**

In `src/extension/ops/planningConstraintChecks.ts`:

1. Add the import: `import { clipToken, MAX_WARNING_CHARS } from '../../planning/draftQualityChecks.js';`
2. Replace `const ARCH_DIR = join('docs', 'arch');` and the `archKeysOf` function with:

```ts
type DesignNamespace = 'arch' | 'ui';
/**
 * The design-key namespaces. Keys are bare tokens (`^…$`). `@ui` allows the
 * dotted (`@ui:1.1`) and lowercase-suffix (`@ui:UI-R09b`) keys that
 * docs/ui uses; `@arch` keeps its upper-case class.
 */
const DESIGN_NAMESPACES: Record<DesignNamespace, { key: RegExp; ref: RegExp; dir: string }> = {
  arch: { key: /^[A-Z0-9_-]+$/, ref: /\[@arch:([A-Z0-9_-]+)\]/g, dir: join('docs', 'arch') },
  ui: { key: /^[A-Za-z0-9._-]+$/, ref: /\[@ui:([A-Za-z0-9._-]+)\]/g, dir: join('docs', 'ui') },
};
const DESIGN_PREFIX = /^@(arch|ui):/;
const MALFORMED_PREFIX = 'malformed design key ';
const UNKNOWN_PREFIX = 'unknown design key ';

type DesignKey = { ns: DesignNamespace; key: string } | 'malformed' | undefined;

/** A `@arch:KEY` / `@ui:KEY` constraint, `'malformed'` for a bad key, undefined for any other entry. */
function parseDesignKey(c: string): DesignKey {
  const m = DESIGN_PREFIX.exec(c);
  if (!m) return undefined;
  const ns = m[1] as DesignNamespace;
  const key = c.slice(m[0].length);
  return DESIGN_NAMESPACES[ns].key.test(key) ? { ns, key } : 'malformed';
}

/** Every `[@<ns>:KEY]` named in a repo's docs/<ns>/*.md; undefined when unreadable. */
function designKeysOf(repoPath: string, ns: DesignNamespace): Set<string> | undefined {
  const { dir, ref } = DESIGN_NAMESPACES[ns];
  try {
    const abs = join(repoPath, dir);
    const keys = new Set<string>();
    for (const f of readdirSync(abs).filter((n) => n.endsWith('.md'))) {
      for (const m of readFileSync(join(abs, f), 'utf8').matchAll(ref)) keys.add(m[1]!);
    }
    return keys;
  } catch {
    return undefined;
  }
}
```

3. Replace `archDocFiles` with:

```ts
/** For each `@arch:KEY` / `@ui:KEY` constraint, the docs/<ns> file (by name) that defines it. */
export function archDocFiles(constraints: readonly string[], repoPaths: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of constraints) {
    const parsed = parseDesignKey(c);
    if (parsed === undefined || parsed === 'malformed') continue;
    const { dir } = DESIGN_NAMESPACES[parsed.ns];
    for (const repo of repoPaths) {
      const abs = join(repo, dir);
      try {
        const file = readdirSync(abs)
          .filter((n) => n.endsWith('.md'))
          .find((n) => readFileSync(join(abs, n), 'utf8').includes(`[@${parsed.ns}:${parsed.key}]`));
        if (file) {
          out[c] = file;
          break;
        }
      } catch {
        // unreadable docs: the chip simply shows no file name
      }
    }
  }
  return out;
}
```

4. Replace `archWarnings` with:

```ts
export function archWarnings(constraints: readonly string[], repoPaths: readonly string[], debug: Debug): string[] {
  const malformed = constraints
    .filter((c) => parseDesignKey(c) === 'malformed')
    .map((c) => `${MALFORMED_PREFIX}${clipToken(c, MAX_WARNING_CHARS - MALFORMED_PREFIX.length)}`);
  const unknown: string[] = [];
  for (const ns of ['ui', 'arch'] as const) {
    const wanted = constraints.filter((c) => {
      const p = parseDesignKey(c);
      return p !== undefined && p !== 'malformed' && p.ns === ns;
    });
    if (wanted.length === 0 || repoPaths.length === 0) continue;
    const sets = repoPaths.map((r) => designKeysOf(r, ns)).filter((s): s is Set<string> => s !== undefined);
    if (sets.length === 0) {
      debug(`[planning] constraint check: no readable docs/${ns} in ${repoPaths.length} repo(s) — @${ns} keys not verified`);
      continue;
    }
    for (const c of wanted) {
      const key = c.slice(`@${ns}:`.length);
      if (!sets.some((s) => s.has(key))) unknown.push(`${UNKNOWN_PREFIX}${clipToken(c, MAX_WARNING_CHARS - UNKNOWN_PREFIX.length)}`);
    }
  }
  return [...malformed, ...unknown];
}
```

Note: the loop order `['ui', 'arch']` gives the order that the test "does not accept an @ui key from docs/arch" expects (`@ui:` first). The existing tests have only `@arch:` keys, so they keep their order. The existing debug text for `docs/arch` stays the same apart from `@arch keys not verified`, which the template produces.

5. Keep `ARCH_CONSTRAINT` (it is used by `sensitivePathWarning`). Delete the old `ARCH_DIR` constant only if nothing else uses it (`grep -n ARCH_DIR src/extension/ops/planningConstraintChecks.ts`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/extension/ops/planningConstraintChecks.test.ts`
Expected: PASS, the old tests included (`skips with a debug line when no repo has readable docs` still sees a `[planning]` debug line).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run -s typecheck`
Expected: exit 0.

```bash
git add src/extension/ops/planningConstraintChecks.ts src/extension/ops/planningConstraintChecks.test.ts
git commit -m "feat(planning): verify @ui design keys and clip constraint warnings to 60 chars"
```

---

### Task 3: Batched git path verification at the planned base

**Files:**
- Modify: `src/extension/ops/planningConstraintChecks.ts`
- Test: `src/extension/ops/planningConstraintChecks.test.ts` (fake batch)
- Create: `src/extension/ops/planningConstraintChecks.integration.test.ts` (real git)

**Interfaces:**
- Consumes: `clipToken`, `MAX_WARNING_CHARS` (Task 1); `resolveBaselineBranch` (exists); `Manifest` type (exists).
- Produces:
  - `export interface PathRepoTarget { repoPath: string; baseBranch: string }`
  - `export type GitBatch = (repoPath: string, input: string) => Promise<string>`
  - `export const MAX_CHECKED_PATHS = 50`, `export const MAX_MISSING_PATH_WARNINGS = 3`
  - `export function repoTargetsOf(manifest: Manifest | undefined, names: readonly string[]): PathRepoTarget[]`
  - `export function pathVariants(path: string): string[]`
  - `export async function missingPathsViaGitBatch(target: PathRepoTarget, paths: readonly string[], batch: GitBatch): Promise<string[] | undefined>` — the missing paths, or undefined when no base ref resolves.
  - `export async function missingPathWarnings(paths: readonly string[], targets: readonly PathRepoTarget[], batch: GitBatch, debug: (line: string) => void): Promise<string[]>`
  - `export function gitCatFileBatch(repoPath: string, input: string): Promise<string>` — the default async runner.

- [ ] **Step 1: Write the failing unit tests**

Add to the imports of `src/extension/ops/planningConstraintChecks.test.ts`: `missingPathWarnings, missingPathsViaGitBatch, pathVariants, repoTargetsOf, MAX_CHECKED_PATHS, type GitBatch`. Then add:

```ts
const SHA = 'a'.repeat(40);
/** A fake `cat-file --batch-check`: `known` lines resolve, every other line is missing. */
function fakeBatch(known: (line: string) => boolean): GitBatch & { calls: { repoPath: string; lines: string[] }[] } {
  const calls: { repoPath: string; lines: string[] }[] = [];
  const fn = async (repoPath: string, input: string): Promise<string> => {
    const lines = input.split('\n').filter((l) => l !== '');
    calls.push({ repoPath, lines });
    return lines.map((l) => (known(l) ? `${SHA} blob 12` : `${l} missing`)).join('\n') + '\n';
  };
  return Object.assign(fn, { calls });
}

describe('repoTargetsOf', () => {
  it('dedupes by repoPath and resolves the base branch of the first name', () => {
    const manifest = {
      baselineBranch: 'develop',
      repositories: { a: { repoPath: '/x' }, b: { repoPath: '/x', baselineBranch: 'other' }, c: { repoPath: '/y', baselineBranch: 'main' } },
    } as unknown as Manifest;
    expect(repoTargetsOf(manifest, ['a', 'b', 'c', 'zz'])).toEqual([
      { repoPath: '/x', baseBranch: 'develop' },
      { repoPath: '/y', baseBranch: 'main' },
    ]);
    expect(repoTargetsOf(undefined, ['a'])).toEqual([]);
  });
});

describe('pathVariants', () => {
  it('adds .ts and .tsx for a .js specifier only', () => {
    expect(pathVariants('src/a.js')).toEqual(['src/a.js', 'src/a.ts', 'src/a.tsx']);
    expect(pathVariants('src/a.ts')).toEqual(['src/a.ts']);
    expect(pathVariants('src/a.json')).toEqual(['src/a.json']);
  });
});

describe('missingPathsViaGitBatch', () => {
  const target = { repoPath: '/r', baseBranch: 'develop' };
  it('sends every ref and every path in ONE batch and uses origin/<base> first', async () => {
    const batch = fakeBatch((l) => l === 'origin/develop^{commit}' || l === 'develop^{commit}' || l === 'origin/develop:src/a.ts' || l === 'develop:src/b.ts');
    expect(await missingPathsViaGitBatch(target, ['src/a.ts', 'src/b.ts'], batch)).toEqual(['src/b.ts']);
    expect(batch.calls).toHaveLength(1);
    expect(batch.calls[0]!.lines.slice(0, 3)).toEqual(['origin/develop^{commit}', 'develop^{commit}', 'HEAD^{commit}']);
  });
  it('falls back to the local branch, then HEAD', async () => {
    const local = fakeBatch((l) => l === 'develop^{commit}' || l === 'develop:src/a.ts');
    expect(await missingPathsViaGitBatch(target, ['src/a.ts', 'src/b.ts'], local)).toEqual(['src/b.ts']);
    const head = fakeBatch((l) => l === 'HEAD^{commit}' || l === 'HEAD:src/b.ts');
    expect(await missingPathsViaGitBatch(target, ['src/a.ts', 'src/b.ts'], head)).toEqual(['src/a.ts']);
  });
  it('is undefined when no ref resolves', async () => {
    expect(await missingPathsViaGitBatch(target, ['src/a.ts'], fakeBatch(() => false))).toBeUndefined();
  });
  it('a .js path counts as present when its .ts or .tsx source exists', async () => {
    const batch = fakeBatch((l) => l === 'origin/develop^{commit}' || l === 'origin/develop:src/a.ts' || l === 'origin/develop:src/b.tsx');
    expect(await missingPathsViaGitBatch(target, ['src/a.js', 'src/b.js', 'src/c.js'], batch)).toEqual(['src/c.js']);
  });
  it('reads a line as present only when it is "<sha> <type> <size>"', async () => {
    const batch: GitBatch = async () => `${SHA} commit 200\n${SHA} commit 200\n${SHA} commit 200\nsrc/a.ts ambiguous\n\n`;
    expect(await missingPathsViaGitBatch(target, ['src/a.ts'], batch)).toEqual(['src/a.ts']);
  });
});

describe('missingPathWarnings', () => {
  const t1 = { repoPath: '/r1', baseBranch: 'main' };
  const t2 = { repoPath: '/r2', baseBranch: 'main' };
  const resolves = (l: string) => l.endsWith('^{commit}');
  it('runs one batch per target and warns on a path missing in every target', async () => {
    const batch = fakeBatch((l) => resolves(l) || l === 'origin/main:src/a.ts');
    const w = await missingPathWarnings(['src/a.ts', 'src/b.ts'], [t1, t2], batch, vi.fn());
    expect(w).toEqual(['missing path at base: src/b.ts']);
    expect(batch.calls.map((c) => c.repoPath)).toEqual(['/r1', '/r2']);
  });
  it('caps the output at 3 paths and one "+N more" line', async () => {
    const paths = ['src/1.ts', 'src/2.ts', 'src/3.ts', 'src/4.ts', 'src/5.ts'];
    expect(await missingPathWarnings(paths, [t1], fakeBatch(resolves), vi.fn())).toEqual([
      'missing path at base: src/1.ts',
      'missing path at base: src/2.ts',
      'missing path at base: src/3.ts',
      '+2 more missing paths at base',
    ]);
    expect(await missingPathWarnings(paths.slice(0, 3), [t1], fakeBatch(resolves), vi.fn())).toHaveLength(3);
  });
  it('checks at most 50 distinct paths and drops paths with a line break', async () => {
    const batch = fakeBatch(resolves);
    const paths = Array.from({ length: 60 }, (_, i) => `src/f${i}.ts`);
    await missingPathWarnings([...paths, 'src/f0.ts', 'src/x\n.ts', 'src/y\r.ts'], [t1], batch, vi.fn());
    const pathLines = batch.calls[0]!.lines.filter((l) => l.startsWith('HEAD:'));
    expect(pathLines).toHaveLength(MAX_CHECKED_PATHS);
    expect(pathLines.some((l) => /[\r\n]/.test(l))).toBe(false);
  });
  it('is silent with no paths or no targets, and spawns nothing', async () => {
    const batch = fakeBatch(resolves);
    expect(await missingPathWarnings([], [t1], batch, vi.fn())).toEqual([]);
    expect(await missingPathWarnings(['src/a.ts'], [], batch, vi.fn())).toEqual([]);
    expect(batch.calls).toHaveLength(0);
  });
  it('skips a target whose git fails or whose base does not resolve, with a [planning] debug line', async () => {
    const debug = vi.fn();
    const batch: GitBatch = async (repoPath, input) => {
      if (repoPath === '/r1') throw new Error('spawn git ENOENT');
      return fakeBatch(() => false)(repoPath, input);
    };
    expect(await missingPathWarnings(['src/a.ts'], [t1, t2], batch, debug)).toEqual([]);
    expect(debug).toHaveBeenCalledWith(expect.stringMatching(/^\[planning\] .*\/r1.*spawn git ENOENT/));
    expect(debug).toHaveBeenCalledWith(expect.stringMatching(/^\[planning\] .*\/r2.*no base ref/));
  });
  it('a path present in one checked target and missing in another is not reported', async () => {
    const batch: GitBatch = async (repoPath, input) => fakeBatch((l) => resolves(l) || (repoPath === '/r2' && l === 'origin/main:src/a.ts'))(repoPath, input);
    expect(await missingPathWarnings(['src/a.ts'], [t1, t2], batch, vi.fn())).toEqual([]);
  });
  it('clips a long path to keep the warning at 60 chars', async () => {
    const long = `src/${'deep/'.repeat(20)}file.ts`;
    const [w] = await missingPathWarnings([long], [t1], fakeBatch(resolves), vi.fn());
    expect(w!.length).toBeLessThanOrEqual(60);
    expect(w).toMatch(/^missing path at base: ….*file\.ts$/);
  });
});
```

Add `import type { Manifest } from '../../manifest/types.js';` to the test imports.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/extension/ops/planningConstraintChecks.test.ts`
Expected: FAIL with `missingPathWarnings is not a function` (or an import error).

- [ ] **Step 3: Write the implementation**

Append to `src/extension/ops/planningConstraintChecks.ts`:

```ts
/** A distinct repository checkout and the base branch its draft is planned against. */
export interface PathRepoTarget {
  repoPath: string;
  baseBranch: string;
}
/** One async `git cat-file --batch-check` in `repoPath`, `input` on stdin; resolves to stdout. */
export type GitBatch = (repoPath: string, input: string) => Promise<string>;

export const MAX_CHECKED_PATHS = 50;
export const MAX_MISSING_PATH_WARNINGS = 3;
const GIT_BATCH_TIMEOUT_MS = 5000;
const GIT_BATCH_MAX_BUFFER = 1024 * 1024;
const OBJECT_LINE = /^[0-9a-f]{40,64} \S+ \d+$/;
const MISSING_PREFIX = 'missing path at base: ';

/** The distinct repoPaths of the named repositories, each with its base branch (BASE-PER). */
export function repoTargetsOf(manifest: Manifest | undefined, names: readonly string[]): PathRepoTarget[] {
  if (!manifest) return [];
  const byPath = new Map<string, PathRepoTarget>();
  for (const name of names) {
    const repository = manifest.repositories[name];
    if (!repository?.repoPath || byPath.has(repository.repoPath)) continue;
    byPath.set(repository.repoPath, { repoPath: repository.repoPath, baseBranch: resolveBaselineBranch(manifest, repository) });
  }
  return [...byPath.values()];
}

/** The spellings that count as `path` at base: an ESM `.js` specifier also matches its `.ts`/`.tsx` source. */
export function pathVariants(path: string): string[] {
  if (!path.endsWith('.js')) return [path];
  const stem = path.slice(0, -'.js'.length);
  return [path, `${stem}.ts`, `${stem}.tsx`];
}

/**
 * The paths missing at the planned base of `target`, from ONE `cat-file
 * --batch-check`: the input holds `<ref>^{commit}` for `origin/<base>`,
 * `<base>` and `HEAD`, then `<ref>:<path>` for every ref and path variant.
 * The first ref that resolves wins. Undefined when none resolves.
 */
export async function missingPathsViaGitBatch(
  target: PathRepoTarget,
  paths: readonly string[],
  batch: GitBatch,
): Promise<string[] | undefined> {
  const refs = [`origin/${target.baseBranch}`, target.baseBranch, 'HEAD'];
  const variants = paths.map(pathVariants);
  const perRef = variants.reduce((n, v) => n + v.length, 0);
  const lines = [
    ...refs.map((r) => `${r}^{commit}`),
    ...refs.flatMap((r) => variants.flatMap((vs) => vs.map((v) => `${r}:${v}`))),
  ];
  const out = (await batch(target.repoPath, `${lines.join('\n')}\n`)).split('\n');
  const found = (i: number): boolean => OBJECT_LINE.test(out[i] ?? '');
  const refIndex = refs.findIndex((_, i) => found(i));
  if (refIndex === -1) return undefined;
  let cursor = refs.length + refIndex * perRef;
  const missing: string[] = [];
  variants.forEach((vs, i) => {
    if (!vs.some((_, j) => found(cursor + j))) missing.push(paths[i]!);
    cursor += vs.length;
  });
  return missing;
}

/**
 * `missing path at base: <path>` for each path that no checked target has at
 * its planned base (at most 3, then `+N more missing paths at base`). One batch
 * per target, all in parallel. A target whose git fails or whose base does not
 * resolve is skipped with a `[planning]` debug line; with no checked target,
 * nothing is reported.
 */
export async function missingPathWarnings(
  paths: readonly string[],
  targets: readonly PathRepoTarget[],
  batch: GitBatch,
  debug: Debug,
): Promise<string[]> {
  const wanted = [...new Set(paths.filter((p) => !/[\r\n]/.test(p)))].slice(0, MAX_CHECKED_PATHS);
  if (wanted.length === 0 || targets.length === 0) return [];
  const results = await Promise.all(
    targets.map((t) =>
      missingPathsViaGitBatch(t, wanted, batch).then(
        (missing) => {
          if (missing === undefined) debug(`[planning] path check: no base ref in ${t.repoPath} — paths not verified`);
          return missing;
        },
        (e: unknown) => {
          debug(`[planning] path check in ${t.repoPath} skipped: ${e instanceof Error ? e.message : String(e)}`);
          return undefined;
        },
      ),
    ),
  );
  const checked = results.filter((r): r is string[] => r !== undefined);
  if (checked.length === 0) return [];
  const missing = wanted.filter((p) => checked.every((m) => m.includes(p)));
  const shown = missing
    .slice(0, MAX_MISSING_PATH_WARNINGS)
    .map((p) => `${MISSING_PREFIX}${clipToken(p, MAX_WARNING_CHARS - MISSING_PREFIX.length)}`);
  const rest = missing.length - shown.length;
  return rest > 0 ? [...shown, `+${rest} more missing paths at base`] : shown;
}

/**
 * The default GitBatch: async `git -C <repoPath> cat-file --batch-check` with
 * `input` on stdin. ASYNC on purpose: it runs in the extension host, whose event
 * loop must never block on a child process. `execFile` kills it on timeout and
 * caps its output.
 */
export function gitCatFileBatch(repoPath: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-C', repoPath, 'cat-file', '--batch-check'],
      { encoding: 'utf8', timeout: GIT_BATCH_TIMEOUT_MS, maxBuffer: GIT_BATCH_MAX_BUFFER },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
    // A stdin failure (EPIPE when git exits early) rejects; a later reject is a no-op.
    child.stdin?.on('error', reject);
    child.stdin?.end(input);
  });
}
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `npx vitest run src/extension/ops/planningConstraintChecks.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the real-git integration test**

Create `src/extension/ops/planningConstraintChecks.integration.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitCatFileBatch, missingPathWarnings } from './planningConstraintChecks.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'karst-paths-'));
  dirs.push(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export {};\n');
  writeFileSync(join(root, 'src', 'with space.ts'), 'export {};\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'init');
  return root;
}

describe('gitCatFileBatch + missingPathWarnings against a real repository', () => {
  it('reports only the path missing at main, accepts .js for .ts, and handles spaces', async () => {
    const root = repo();
    const batch = vi.fn(gitCatFileBatch);
    const w = await missingPathWarnings(
      ['src/a.ts', 'src/a.js', 'src/with space.ts', 'src/gone.ts'],
      [{ repoPath: root, baseBranch: 'main' }],
      batch,
      vi.fn(),
    );
    expect(w).toEqual(['missing path at base: src/gone.ts']);
    expect(batch).toHaveBeenCalledTimes(1);
  });
  it('rejects with the git error for a directory that is not a repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'karst-nogit-'));
    dirs.push(plain);
    await expect(gitCatFileBatch(plain, 'HEAD^{commit}\n')).rejects.toThrow();
  });
});
```

The test file uses `execFileSync` only to build the fixture repository. That is allowed: `hostGitFree.test.ts` checks the host modules, not the test files.

- [ ] **Step 6: Run the integration test**

Run: `npx vitest run --config vitest.integration.config.ts src/extension/ops/planningConstraintChecks.integration.test.ts`
Expected: PASS. If the second test does not reject (some git versions print `fatal: not a git repository` and exit 128, which rejects), keep it. If it hangs, the stdin end is missing — check `child.stdin?.end(input)`.

- [ ] **Step 7: Typecheck and commit**

Run: `npm run -s typecheck` and `npx vitest run src/context/hostGitFree.test.ts`
Expected: both exit 0.

```bash
git add src/extension/ops/planningConstraintChecks.ts src/extension/ops/planningConstraintChecks.test.ts src/extension/ops/planningConstraintChecks.integration.test.ts
git commit -m "feat(planning): verify draft paths at the planned base with one git cat-file batch per repo"
```

---

### Task 4: Overlap candidates and the overlap warning

**Files:**
- Modify: `src/store/planningProposals.ts` (export `projectGraph` and `NEW_NODE`)
- Create: `src/store/draftOverlap.ts`
- Test: `src/store/draftOverlap.test.ts`
- Modify: `src/extension/ops/planningConstraintChecks.ts` (add `overlapWarnings`)
- Test: `src/extension/ops/planningConstraintChecks.test.ts`

**Interfaces:**
- Consumes: `extractReferencedPaths`, `jaccard` (Task 1); `projectGraph`, `NEW_NODE`, `listPendingProposals`, `ProposalDependency` (store); `formatId` (model).
- Produces:
  - `export interface OverlapCandidate { ref: string; title: string; description: string }` (in `src/store/draftOverlap.ts`; `ref` is `D<n>` or `T<n>`).
  - `export function connectedNodes(edges: ReadonlyMap<string, readonly string[]>, start: string): Set<string>`
  - `export function listOverlapCandidates(store: Store, projectId: number, incomingId: number | undefined, dependsOn: readonly ProposalDependency[]): OverlapCandidate[]`
  - `export function overlapWarnings(incoming: { title: string; description: string }, candidates: readonly OverlapCandidate[]): string[]` (in `planningConstraintChecks.ts`)
  - Constants `OVERLAP_MIN_SHARED_FILES = 2`, `TITLE_SIMILARITY = 0.65`, `MIN_TITLE_TOKENS = 3`, `MAX_OVERLAP_WARNINGS = 3`.

- [ ] **Step 1: Export the graph helpers**

In `src/store/planningProposals.ts`, change `const NEW_NODE = 'new';` to `export const NEW_NODE = 'new';` and `function projectGraph(` to `export function projectGraph(`. Add one line to the JSDoc of `projectGraph`: `Also read by the overlap check (`store/draftOverlap.ts`) for draft connectivity.` No other change in this file.

- [ ] **Step 2: Write the failing store tests**

Create `src/store/draftOverlap.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { upsertProject } from './projects.js';
import { createTicket } from './tickets.js';
import { createPlanningSession } from './planningSessions.js';
import { insertProposal, markProposalAccepted, discardProposal } from './planningProposals.js';
import { addRelation } from './ticketRelations.js';
import { connectedNodes, listOverlapCandidates } from './draftOverlap.js';

describe('connectedNodes', () => {
  it('follows edges in both directions, transitively', () => {
    const edges = new Map([['A', ['B']], ['C', ['B']], ['D', ['E']]]);
    expect([...connectedNodes(edges, 'A')].sort()).toEqual(['A', 'B', 'C']);
    expect([...connectedNodes(edges, 'Z')]).toEqual(['Z']);
  });
});

describe('listOverlapCandidates', () => {
  let store: Store;
  let projectId: number;
  let sessionId: number;
  const payload = (title: string, description = 'd') => ({ title, description, summary: 's', repos: [] });
  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p' }).id;
    sessionId = createPlanningSession(store, { projectId, title: 's', core: 'claude', model: null }).id;
  });
  afterEach(() => store.close());

  const refs = (incomingId: number | undefined, deps: (number | `T${number}`)[] = []) =>
    listOverlapCandidates(store, projectId, incomingId, deps).map((c) => c.ref);

  it('lists pending drafts and open tickets of the project with their title and description', () => {
    const d = insertProposal(store, sessionId, payload('Draft one', 'src/a.ts'));
    const t = createTicket(store, { key: 'K', title: 'Ticket one', description: 'src/b.ts', projectId }).id;
    expect(listOverlapCandidates(store, projectId, undefined, [])).toEqual([
      { ref: `D${d}`, title: 'Draft one', description: 'src/a.ts' },
      { ref: `T${t}`, title: 'Ticket one', description: 'src/b.ts' },
    ]);
  });
  it('a ticket with no description reads as empty text', () => {
    const t = createTicket(store, { key: 'K', title: 'T', projectId }).id;
    expect(listOverlapCandidates(store, projectId, undefined, [])).toEqual([{ ref: `T${t}`, title: 'T', description: '' }]);
  });
  it('skips done, closed and archived tickets, other projects and discarded drafts', () => {
    const mk = (key: string, set?: string) => {
      const id = createTicket(store, { key, title: key, projectId }).id;
      if (set) store.db.prepare(`UPDATE tickets SET ${set} WHERE id = ?`).run(id);
      return id;
    };
    const open = mk('OPEN');
    mk('DONE', "stage_current = 'done'");
    mk('CLO', "stage_current = 'closed'");
    mk('ARC', "archived_at = datetime('now')");
    const running = mk('RUN', "stage_current = 'impl'");
    const other = upsertProject(store, { slug: 'q' }).id;
    createTicket(store, { key: 'F', title: 'f', projectId: other });
    const gone = insertProposal(store, sessionId, payload('gone'));
    discardProposal(store, gone);
    expect(refs(undefined)).toEqual([`T${open}`, `T${running}`]);
  });
  it('skips the incoming draft itself', () => {
    const a = insertProposal(store, sessionId, payload('a'));
    const b = insertProposal(store, sessionId, payload('b'));
    expect(refs(a)).toEqual([`D${b}`]);
  });
  it('skips drafts and tickets connected through dependsOn, transitively, both ways', () => {
    const a = insertProposal(store, sessionId, payload('a'));
    const b = insertProposal(store, sessionId, { ...payload('b'), dependsOn: [a] });
    const c = insertProposal(store, sessionId, payload('c'));
    const t = createTicket(store, { key: 'K', title: 'k', projectId }).id;
    // new -> b -> a ; c and t are unrelated
    expect(refs(undefined, [b])).toEqual([`D${c}`, `T${t}`]);
    // the revised c depends on T: T is excluded, a and b stay
    expect(refs(c, [`T${t}`])).toEqual([`D${a}`, `D${b}`]);
  });
  it('skips the ticket of an accepted draft in the chain, and a ticket blocked by the incoming draft', () => {
    const a = insertProposal(store, sessionId, payload('a'));
    const ta = createTicket(store, { key: 'KA', title: 'ta', projectId }).id;
    markProposalAccepted(store, a, ta);
    const x = insertProposal(store, sessionId, payload('x'));
    const tb = createTicket(store, { key: 'KB', title: 'tb', projectId }).id;
    addRelation(store, { ticketId: tb, kind: 'blocked-by', targetProposalId: x, source: 'agent' });
    const free = createTicket(store, { key: 'KF', title: 'free', projectId }).id;
    expect(refs(x, [a])).toEqual([`T${free}`]);
  });
});
```

- [ ] **Step 3: Run the store tests to verify they fail**

Run: `npx vitest run src/store/draftOverlap.test.ts`
Expected: FAIL with `Failed to resolve import "./draftOverlap.js"`.

- [ ] **Step 4: Write the store module**

Create `src/store/draftOverlap.ts`:

```ts
import type { Store } from './db.js';
import { listPendingProposals, NEW_NODE, projectGraph, type ProposalDependency } from './planningProposals.js';
import { formatId } from '../model/entityId.js';

/**
 * The open work a new or revised draft is compared with for overlap
 * (`@arch:DRAFT-QUALITY`): the project's pending drafts and its open,
 * non-archived tickets, minus the incoming draft and everything connected to
 * it through dependsOn / blocked-by edges (in either direction, transitively).
 * One light query for tickets, never `listTickets()`.
 */

export interface OverlapCandidate {
  /** `D<n>` (draft) or `T<n>` (ticket). */
  ref: string;
  title: string;
  description: string;
}

const FINISHED_STAGES = ['done', 'closed'] as const;

/** Every node reachable from `start` when each edge counts both ways. */
export function connectedNodes(edges: ReadonlyMap<string, readonly string[]>, start: string): Set<string> {
  const adjacent = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    adjacent.set(a, [...(adjacent.get(a) ?? []), b]);
  };
  for (const [from, tos] of edges) {
    for (const to of tos) {
      link(from, to);
      link(to, from);
    }
  }
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    for (const next of adjacent.get(queue.pop()!) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

export function listOverlapCandidates(
  store: Store,
  projectId: number,
  incomingId: number | undefined,
  dependsOn: readonly ProposalDependency[],
): OverlapCandidate[] {
  const start = incomingId === undefined ? NEW_NODE : formatId('draft', incomingId);
  const linked = connectedNodes(projectGraph(store, projectId, incomingId, dependsOn), start);
  const drafts = listPendingProposals(store, projectId)
    .filter((p) => p.id !== incomingId)
    .map((p) => ({ ref: formatId('draft', p.id), title: p.payload.title, description: p.payload.description }));
  const rows = store.db
    .prepare(
      `SELECT id, title, description FROM tickets
       WHERE project_id = ? AND archived_at IS NULL
         AND (stage_current IS NULL OR stage_current NOT IN (?, ?))
       ORDER BY id`,
    )
    .all(projectId, ...FINISHED_STAGES) as { id: number; title: string; description: string | null }[];
  const tickets = rows.map((t) => ({ ref: formatId('ticket', t.id), title: t.title, description: t.description ?? '' }));
  return [...drafts, ...tickets].filter((c) => !linked.has(c.ref));
}
```

- [ ] **Step 5: Run the store tests to verify they pass**

Run: `npx vitest run src/store/draftOverlap.test.ts src/store/planningProposals.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing overlap-warning tests**

Add `overlapWarnings` to the imports of `src/extension/ops/planningConstraintChecks.test.ts` and add:

```ts
describe('overlapWarnings', () => {
  const incoming = { title: 'Retry token refresh in session store', description: 'Edit src/auth/session.ts and src/auth/token.ts.' };
  const c = (ref: string, title: string, description = '') => ({ ref, title, description });
  it('warns on 2 or more shared source files, not on 1', () => {
    expect(overlapWarnings(incoming, [c('D4', 'x', 'src/auth/session.ts src/auth/token.ts')])).toEqual(['overlaps files with D4 (add dependsOn?)']);
    expect(overlapWarnings(incoming, [c('T9', 'x', 'src/auth/session.ts only')])).toEqual([]);
  });
  it('created paths count as shared files too', () => {
    expect(overlapWarnings({ title: 'a', description: '[NEW] src/n.ts\n[NEW] src/m.ts' }, [c('D1', 'b', 'src/n.ts src/m.ts')])).toHaveLength(1);
  });
  it('does not count docs/** or *.md files', () => {
    const docs = { title: 'a', description: 'docs/arch/cli.md docs/x.ts src/README.md src/a.ts' };
    expect(overlapWarnings(docs, [c('D1', 'b', 'docs/arch/cli.md docs/x.ts src/README.md src/a.ts')])).toEqual([]);
  });
  it('warns on a title Jaccard of 0.65 or more, with 3+ meaningful tokens on both sides', () => {
    const tokens = Array.from({ length: 17 }, (_, i) => `tok${i}`);
    const a = { title: [...tokens.slice(0, 13), 'aaa1', 'aaa2', 'aaa3'].join(' '), description: '' };
    // 13 shared, 3 own + 4 own: 13/20 = 0.65
    expect(overlapWarnings(a, [c('T2', [...tokens.slice(0, 13), 'bbb1', 'bbb2', 'bbb3', 'bbb4'].join(' '))])).toEqual(['title closely matches T2']);
    // 13 shared, 3 own + 5 own: 13/21 < 0.65
    expect(overlapWarnings(a, [c('T2', [...tokens.slice(0, 13), 'bbb1', 'bbb2', 'bbb3', 'bbb4', 'bbb5'].join(' '))])).toEqual([]);
  });
  it('needs 3 tokens of length 3+ that are not stopwords on both sides', () => {
    expect(overlapWarnings({ title: 'Fix auth', description: '' }, [c('D1', 'Fix auth')])).toEqual([]);
    expect(overlapWarnings({ title: 'feat: fix the auth flow', description: '' }, [c('D1', 'feat: fix the auth flow')])).toEqual([]);
    expect(overlapWarnings({ title: 'go to db ui', description: '' }, [c('D1', 'go to db ui')])).toEqual([]);
    expect(overlapWarnings({ title: 'Token refresh retry', description: '' }, [c('D1', 'token REFRESH retry')])).toEqual(['title closely matches D1']);
  });
  it('a file overlap wins over a title match for the same candidate', () => {
    expect(overlapWarnings(incoming, [c('D4', incoming.title, incoming.description)])).toEqual(['overlaps files with D4 (add dependsOn?)']);
  });
  it('caps at 3 warnings, each at most 60 chars', () => {
    const many = Array.from({ length: 5 }, (_, i) => c(`T${100000 + i}`, 'x', incoming.description));
    const w = overlapWarnings(incoming, many);
    expect(w).toHaveLength(3);
    for (const x of w) expect(x.length).toBeLessThanOrEqual(60);
  });
});
```

- [ ] **Step 7: Run the tests to verify they fail**

Run: `npx vitest run src/extension/ops/planningConstraintChecks.test.ts`
Expected: FAIL with `overlapWarnings is not a function`.

- [ ] **Step 8: Write `overlapWarnings`**

In `src/extension/ops/planningConstraintChecks.ts`, extend the Task 1 import to `import { clipToken, extractReferencedPaths, jaccard, MAX_WARNING_CHARS } from '../../planning/draftQualityChecks.js';`, add `import type { OverlapCandidate } from '../../store/draftOverlap.js';`, and append:

```ts
export const OVERLAP_MIN_SHARED_FILES = 2;
export const TITLE_SIMILARITY = 0.65;
export const MIN_TITLE_TOKENS = 3;
export const MAX_OVERLAP_WARNINGS = 3;
const MIN_TOKEN_LENGTH = 3;
const TITLE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'onto', 'that', 'this', 'when', 'not', 'are', 'via', 'per',
  'add', 'fix', 'feat', 'chore', 'docs', 'refactor', 'test', 'tests', 'perf',
]);

/** Source files a draft names (edited or created); docs and Markdown never count as overlap. */
function sourceFilesOf(text: string): Set<string> {
  const { existing, created } = extractReferencedPaths(text);
  return new Set([...existing, ...created].filter((p) => !p.startsWith('docs/') && !p.endsWith('.md')));
}

function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= MIN_TOKEN_LENGTH && !TITLE_STOPWORDS.has(w)),
  );
}

/**
 * Open drafts and tickets that look like the same work as `incoming`: 2+
 * shared source files, else a close title. `candidates` already excludes the
 * draft itself and everything linked to it (`listOverlapCandidates`).
 */
export function overlapWarnings(
  incoming: { title: string; description: string },
  candidates: readonly OverlapCandidate[],
): string[] {
  const files = sourceFilesOf(incoming.description);
  const tokens = titleTokens(incoming.title);
  const out: string[] = [];
  for (const c of candidates) {
    if (out.length >= MAX_OVERLAP_WARNINGS) break;
    const shared = [...sourceFilesOf(c.description)].filter((f) => files.has(f)).length;
    if (shared >= OVERLAP_MIN_SHARED_FILES) {
      out.push(`overlaps files with ${c.ref} (add dependsOn?)`);
      continue;
    }
    const other = titleTokens(c.title);
    if (tokens.size >= MIN_TITLE_TOKENS && other.size >= MIN_TITLE_TOKENS && jaccard(tokens, other) >= TITLE_SIMILARITY) {
      out.push(`title closely matches ${c.ref}`);
    }
  }
  return out;
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run src/extension/ops/planningConstraintChecks.test.ts src/store/draftOverlap.test.ts`
Expected: PASS.

- [ ] **Step 10: Layer lint, typecheck and commit**

Run: `npm run -s lint:layers` and `npm run -s typecheck`
Expected: both exit 0. (`src/extension/ops` → `src/store` and `src/planning` imports already exist in this module's neighbors. If `lint:layers` refuses the type import from `src/store`, move `OverlapCandidate` into `src/planning/draftQualityChecks.ts` and import it from there in both files.)

```bash
git add src/store/planningProposals.ts src/store/draftOverlap.ts src/store/draftOverlap.test.ts src/extension/ops/planningConstraintChecks.ts src/extension/ops/planningConstraintChecks.test.ts
git commit -m "feat(planning): warn when a draft overlaps open drafts or tickets"
```

---

### Task 5: Run the checks at ingest and revise

**Files:**
- Modify: `src/extension/ops/planningOutbox.ts`
- Modify: `src/extension.ts:206` (import) and `src/extension.ts:7510` (deps)
- Test: `src/extension/ops/planningOutbox.integration.test.ts`

**Interfaces:**
- Consumes: `draftQualityWarnings`, `extractReferencedPaths` (Task 1); `missingPathWarnings`, `repoTargetsOf`, `gitCatFileBatch`, `PathRepoTarget`, `GitBatch`, `overlapWarnings` (Tasks 3–4); `listOverlapCandidates` (Task 4); `planningArtifactsDir` (`src/planning/preamble.ts`).
- Produces: two new optional deps on `PlanningOutboxDeps`:
  - `pathTargets?(names: string[]): PathRepoTarget[]`
  - `gitBatch?: GitBatch`
  No other public change. `checkingIds()` stays the same.

- [ ] **Step 1: Update the fixture and the two affected tests**

In `src/extension/ops/planningOutbox.integration.test.ts`:

Replace line 30 with:

```ts
const good = {
  title: 'Fix auth',
  description:
    'Renew an expired token once in src/auth/session.ts before the request fails.\n' +
    'Verify: a vitest case for the expired token passes under npx vitest run.',
  summary: 'The login flow drops users when the token expires; renew it once and keep the retry bounded.',
  repos: ['api'],
};
```

(One source path, so two `good` drafts share 1 file and never trigger the overlap warning. `Fix auth` has 2 title tokens, so no title warning. No line has a created marker, so the path is `existing`.)

Replace the two `put` lines of the test `warns for a sensitive path without a rule, not with one` with:

```ts
      const seed = good.description.replace('src/auth/session.ts', 'src/agent/seed.ts');
      put(`${UUID(1)}.json`, { ...good, description: seed });
      put(`${UUID(2)}.json`, { ...good, description: seed, constraints: ['@arch:RESIDENT'] });
```

In the test `names the proposal in the log and still clears checking when a late warning write throws`, change the expected debug line to:

```ts
      expect(debug).toHaveBeenCalledWith(`[planning] async checks for proposal ${id} failed (boom)`);
```

- [ ] **Step 2: Write the new failing tests**

Add, inside `describe('constraint warnings', …)` after the last test:

```ts
    describe('draft quality', () => {
      it('stores the quality warnings of a thin draft', () => {
        put(`${UUID(1)}.json`, { ...good, description: 'd', summary: 's' });
        make().scan();
        expect(pending()[0]!.warnings).toEqual(['description is short (1 chars)', 'summary is short (1 chars)']);
      });
      it('flags an inverted draft on ingest and clears it on a fixed revise', () => {
        const inverted = {
          ...good,
          description: `${'Return host warnings to the planner. '.repeat(4)}`,
          summary: '1. Edit src/cli/draftCommand.ts.\n2. Edit src/extension/ops/planningOutbox.ts.\n3. Run vitest.',
        };
        put(`${UUID(1)}.json`, inverted);
        make().scan();
        const id = pending()[0]!.id;
        expect(getProposal(store, id)!.warnings).toContain('plan details in summary instead of description');
        put(`${UUID(2)}.json`, { ...good, id });
        make().scan();
        expect(getProposal(store, id)!.warnings).toEqual([]);
      });
      it('reads only the names in <scratch>/artifacts for the dropped-plan check', () => {
        mkdirSync(join(scratch, 'artifacts'), { recursive: true });
        writeFileSync(join(scratch, 'artifacts', 'plan.md'), '# plan');
        put(`${UUID(1)}.json`, good);
        const readFileSync = vi.fn(nodeFs.readFileSync);
        make({ fs: { ...nodeFs, readFileSync } as typeof nodeFs }).scan();
        expect(pending()[0]!.warnings).toEqual(['session has plan artifact but description is short']);
        expect(readFileSync.mock.calls.some(([p]) => String(p).includes('artifacts'))).toBe(false);
      });
      it('ignores a non-Markdown artifact and a missing artifacts dir', () => {
        put(`${UUID(1)}.json`, good);
        make().scan();
        mkdirSync(join(scratch, 'artifacts'), { recursive: true });
        writeFileSync(join(scratch, 'artifacts', 'shot.png'), 'x');
        put(`${UUID(2)}.json`, { ...good, title: 'Other' });
        make().scan();
        expect(pending().map((p) => p.warnings)).toEqual([[], []]);
      });
      it('warns when a new draft overlaps an open ticket, not when it depends on it', () => {
        const desc = `${good.description}\nAlso src/auth/token.ts.`;
        const t = createTicket(store, { key: 'K', title: 'k', description: desc, projectId }).id;
        put(`${UUID(1)}.json`, { ...good, description: desc });
        put(`${UUID(2)}.json`, { ...good, title: 'Second', description: desc, dependsOn: [`T${t}`] });
        make().scan();
        const [a, b] = pending();
        expect(a!.warnings).toEqual([`overlaps files with T${t} (add dependsOn?)`]);
        expect(b!.warnings).toEqual([`overlaps files with D${a!.id} (add dependsOn?)`]);
      });
      it('a failing overlap query is skipped with a debug line, and the draft is stored', () => {
        const debug = vi.fn();
        store.db.exec('ALTER TABLE tickets RENAME TO tickets_gone');
        put(`${UUID(1)}.json`, good);
        make({ debug }).scan();
        store.db.exec('ALTER TABLE tickets_gone RENAME TO tickets');
        expect(pending()).toHaveLength(1);
        expect(debug.mock.calls.some(([l]) => /\[planning\] overlap check .* skipped/.test(String(l)))).toBe(true);
      });
    });

    describe('missing paths at base', () => {
      const target = { repoPath: '/r', baseBranch: 'main' };
      const batchMissing = (missing: string[]) =>
        vi.fn(async (_repo: string, input: string) =>
          input
            .split('\n')
            .filter(Boolean)
            .map((l) => (l.endsWith('^{commit}') || !missing.some((m) => l.endsWith(`:${m}`)) ? `${'a'.repeat(40)} blob 1` : `${l} missing`))
            .join('\n'),
        );
      it('adds the missing-path warning once the batch answers, holding checking until then', async () => {
        const gitBatch = batchMissing(['src/auth/session.ts']);
        const ob = make({ pathTargets: () => [target], gitBatch });
        put(`${UUID(1)}.json`, good);
        ob.scan();
        const id = pending()[0]!.id;
        expect(readProposalIndex(scratch)[0]).toMatchObject({ id, checking: true });
        await flush();
        expect(getProposal(store, id)!.warnings).toEqual(['missing path at base: src/auth/session.ts']);
        expect('checking' in readProposalIndex(scratch)[0]!).toBe(false);
        expect(gitBatch).toHaveBeenCalledTimes(1);
      });
      it('does not run the probe for a draft that names only created paths', async () => {
        const gitBatch = batchMissing([]);
        put(`${UUID(1)}.json`, { ...good, description: good.description.replace('Renew', '[NEW] Renew') });
        make({ pathTargets: () => [target], gitBatch }).scan();
        expect('checking' in readProposalIndex(scratch)[0]!).toBe(false);
        expect(gitBatch).not.toHaveBeenCalled();
      });
      it('holds ONE latch for the commit and path probes and merges both warnings', async () => {
        let releaseCommit!: () => void;
        const commitGate = new Promise<void>((r) => (releaseCommit = r));
        const ob = make({
          repoPaths: () => [repo],
          commitExists: async () => {
            await commitGate;
            return false;
          },
          pathTargets: () => [target],
          gitBatch: batchMissing(['src/auth/session.ts']),
        });
        put(`${UUID(1)}.json`, { ...good, constraints: ['abc1234'] });
        ob.scan();
        const id = pending()[0]!.id;
        await flush();
        expect(ob.checkingIds().has(id)).toBe(true);
        releaseCommit();
        await flush();
        expect(ob.checkingIds().size).toBe(0);
        expect(getProposal(store, id)!.warnings).toEqual(['unknown commit abc1234', 'missing path at base: src/auth/session.ts']);
      });
      it('a failing batch leaves no warning and clears checking', async () => {
        const debug = vi.fn();
        const ob = make({ pathTargets: () => [target], gitBatch: async () => { throw new Error('no git'); }, debug });
        put(`${UUID(1)}.json`, good);
        ob.scan();
        await flush();
        expect(pending()[0]!.warnings).toEqual([]);
        expect(ob.checkingIds().size).toBe(0);
        expect(debug.mock.calls.some(([l]) => String(l).includes('no git'))).toBe(true);
      });
    });
```

Add `createTicket` is already imported at the top of the file (line 18). Check that `flush` is in scope (it is defined in the `constraint warnings` describe).

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run --config vitest.integration.config.ts src/extension/ops/planningOutbox.integration.test.ts`
Expected: FAIL — the `draft quality` and `missing paths at base` tests fail (no such warnings yet), and the log-text test fails on `async checks for proposal`. The other tests PASS with the new fixture.

- [ ] **Step 4: Implement the outbox changes**

In `src/extension/ops/planningOutbox.ts`:

1. Change the imports:

```ts
import { MAX_PROPOSAL_BYTES, validateProposal, type Proposal } from '../../planning/proposal.js';
import { planningArtifactsDir, planningOutboxDir } from '../../planning/preamble.js';
import { draftQualityWarnings, extractReferencedPaths } from '../../planning/draftQualityChecks.js';
import {
  archWarnings,
  commitWarnings,
  missingPathWarnings,
  overlapWarnings,
  sensitivePathWarning,
  type CommitExists,
  type GitBatch,
  type PathRepoTarget,
} from './planningConstraintChecks.js';
import { listOverlapCandidates } from '../../store/draftOverlap.js';
```

(Remove the old single-name `planningOutboxDir` import line.)

2. Add to `PlanningOutboxDeps`, after `commitExists`:

```ts
  /** Repo names → distinct (repoPath, base branch) targets for the path probe; absent = path check skipped. */
  pathTargets?(names: string[]): PathRepoTarget[];
  /** Async `git cat-file --batch-check`, one per target; absent = path check skipped. */
  gitBatch?: GitBatch;
```

3. Add a small message helper below `errCode`:

```ts
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
```

4. Replace `quickWarnings` with:

```ts
  /** True when the session's artifacts dir holds a Markdown file. Reads names only, never content. */
  function hasPlanArtifact(scratch: string): boolean {
    try {
      return fs.readdirSync(planningArtifactsDir(scratch)).some((n) => n.endsWith('.md'));
    } catch (e) {
      if (errCode(e) !== 'ENOENT') debug(`artifacts dir unreadable (${errCode(e) ?? 'error'})`);
      return false;
    }
  }

  /** Overlap with open drafts and tickets; a store failure skips the check with a debug line. */
  function overlapOf(p: Proposal, id: number | undefined): string[] {
    const projectId = deps.projectId();
    if (projectId === undefined) return [];
    try {
      return overlapWarnings(p, listOverlapCandidates(deps.store, projectId, id, p.dependsOn ?? []));
    } catch (e) {
      debug(`overlap check for ${id === undefined ? 'a new draft' : formatId('draft', id)} skipped (${messageOf(e)})`);
      return [];
    }
  }

  /**
   * Warnings computable without spawning anything: design keys, sensitive code
   * with no rule, draft quality (`@arch:DRAFT-QUALITY`) and overlap. `id` is the
   * revised draft, undefined for a new one.
   */
  function quickWarnings(p: Proposal, scratch: string, id: number | undefined): string[] {
    const paths = deps.repoPaths?.(p.repos) ?? [];
    return [
      ...archWarnings(p.constraints ?? [], paths, debug),
      ...sensitivePathWarning(p),
      ...draftQualityWarnings(p, { hasPlanArtifact: hasPlanArtifact(scratch) }),
      ...overlapOf(p, id),
    ];
  }
```

5. Replace `willVerifyCommits` and `verifyCommits` with:

```ts
  /** The commit probe runs when a probe and repo paths exist. */
  function commitProbeRuns(p: Proposal): boolean {
    return deps.commitExists !== undefined && (deps.repoPaths?.(p.repos) ?? []).length > 0;
  }

  /** The path probe input, or undefined when it does not run (no batch, no target, or no edited path). */
  function pathProbe(p: Proposal): { paths: string[]; targets: PathRepoTarget[] } | undefined {
    if (!deps.gitBatch) return undefined;
    const targets = deps.pathTargets?.(p.repos) ?? [];
    const paths = extractReferencedPaths(p.description).existing;
    return targets.length > 0 && paths.length > 0 ? { paths, targets } : undefined;
  }

  /** True when an async check (commit or path probe) will run for this draft. */
  function willVerify(p: Proposal): boolean {
    return commitProbeRuns(p) || pathProbe(p) !== undefined;
  }

  /**
   * The git-backed warnings (unknown commits, paths missing at base) land on
   * the stored row once BOTH probes settle, in one write. The `finally` ALWAYS
   * clears this uuid's latch and refreshes the index (also with no extra
   * warning, and on an error), so `checking: true` never sticks.
   */
  function verifyAsync(sessionId: number, scratch: string, id: number, uuid: string, p: Proposal): void {
    if (!willVerify(p)) return;
    const probe = pathProbe(p);
    const commits = commitProbeRuns(p)
      ? commitWarnings(p.constraints ?? [], deps.repoPaths!(p.repos), deps.commitExists!, debug)
      : Promise.resolve<string[]>([]);
    const missing = probe ? missingPathWarnings(probe.paths, probe.targets, deps.gitBatch!, debug) : Promise.resolve<string[]>([]);
    void Promise.allSettled([commits, missing])
      .then((settled) => {
        const extra = settled.flatMap((s) => {
          if (s.status === 'fulfilled') return s.value;
          debug(`async check for proposal ${id} failed (${messageOf(s.reason)})`);
          return [];
        });
        if (extra.length === 0) return;
        const cur = getProposal(deps.store, id);
        // A revise or resolution since ingest owns the warnings now.
        if (!cur || cur.status !== 'pending' || cur.sourceUuid !== uuid) return;
        setProposalWarnings(deps.store, id, [...cur.warnings, ...extra]);
        const row = getProposal(deps.store, id);
        if (row) deps.onWarnings?.(row);
      })
      .catch((e: unknown) => debug(`async checks for proposal ${id} failed (${messageOf(e)})`))
      .finally(() => {
        if (checking.get(id) !== uuid) return;
        checking.delete(id);
        safeRefresh(sessionId, scratch);
      });
  }
```

6. In `ingest`, the revise branch: replace `updateProposalPayload(deps.store, requestedId, payload, uuid, quickWarnings(read.value));` with `updateProposalPayload(deps.store, requestedId, payload, uuid, quickWarnings(read.value, scratch, requestedId));`, replace `if (willVerifyCommits(read.value)) checking.set(requestedId, uuid);` with `if (willVerify(read.value)) checking.set(requestedId, uuid);`, and replace `verifyCommits(sessionId, scratch, requestedId, uuid, read.value);` with `verifyAsync(sessionId, scratch, requestedId, uuid, read.value);`.

7. In `ingest`, the new-draft branch: replace `insertProposal(deps.store, sessionId, payload, uuid, quickWarnings(read.value))` with `insertProposal(deps.store, sessionId, payload, uuid, quickWarnings(read.value, scratch, undefined))`, `if (willVerifyCommits(read.value)) checking.set(id, uuid);` with `if (willVerify(read.value)) checking.set(id, uuid);`, and `verifyCommits(sessionId, scratch, id, uuid, read.value);` with `verifyAsync(sessionId, scratch, id, uuid, read.value);`.

8. `grep -n "willVerifyCommits\|verifyCommits" src/extension/ops/planningOutbox.ts` must print nothing.

- [ ] **Step 5: Run the outbox tests to verify they pass**

Run: `npx vitest run --config vitest.integration.config.ts src/extension/ops/planningOutbox.integration.test.ts`
Expected: PASS. If an older test now fails only because of a new quality or overlap warning, the cause is its test data: spread `good` (with its well-formed description) into it. Do not weaken a check.

- [ ] **Step 6: Wire the extension**

In `src/extension.ts`, line 206, add `gitCatFileBatch, repoTargetsOf` to the import from `./extension/ops/planningConstraintChecks.js`:

```ts
import { createPlanningOutbox } from './extension/ops/planningOutbox.js'; import { archDocFiles, commitExistsViaGit, gitCatFileBatch, repoPathsOf, repoTargetsOf, resolveBaseShasOf } from './extension/ops/planningConstraintChecks.js';
```

At line ~7510, replace the deps line

```ts
    repoPaths: (names) => repoPathsOf(currentManifest(), names), resolveBaseShas: (names) => resolveBaseShasOf(currentManifest(), names), commitExists: (r, h) => commitExistsViaGit(r, h, execGit), onWarnings: () => provider.refresh() });
```

with

```ts
    repoPaths: (names) => repoPathsOf(currentManifest(), names), resolveBaseShas: (names) => resolveBaseShasOf(currentManifest(), names), commitExists: (r, h) => commitExistsViaGit(r, h, execGit),
    pathTargets: (names) => repoTargetsOf(currentManifest(), names), gitBatch: gitCatFileBatch, onWarnings: () => provider.refresh() });
```

- [ ] **Step 7: Run the guard tests and typecheck**

Run: `npx vitest run src/context/hostGitFree.test.ts src/extension/ops/ratchet.test.ts` and `npm run -s typecheck`
Expected: all exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/extension/ops/planningOutbox.ts src/extension/ops/planningOutbox.integration.test.ts src/extension.ts
git commit -m "feat(planning): run draft quality, overlap and path checks at ingest and revise"
```

---

### Task 6: Docs, index, covers and the system map

**Files:**
- Modify: `docs/arch/cli.md` (new block after `END_DOC_BLOCK: [@arch:DRAFT-CONSTRAINTS]`; edits in `@arch:DRAFT-CONSTRAINTS` and `@arch:CLI-17`)
- Modify: `docs/arch/store-and-schema.md` (`@arch:PLANNING`, `@arch:PLANNING-DEPS`)
- Regenerate: `docs/INDEX.md`, `docs/COVERS.json`, `docs/arch/system-map.md`

**Interfaces:**
- Consumes: the symbols of Tasks 1–5.
- Produces: the `@arch:DRAFT-QUALITY` key.

CAUTION: Do not grow `@arch:PLANNING` (5590 bytes) or `@arch:CLI-17` (3971 bytes) by more than one sentence each. `MAX_BLOCK_BYTES` is 6400 and `docs:check` refuses the marker for a block over the cap.

- [ ] **Step 1: Add the new block**

Insert after the line `END_DOC_BLOCK: [@arch:DRAFT-CONSTRAINTS]` in `docs/arch/cli.md` (one blank line before and after):

```markdown
## [@arch:DRAFT-QUALITY] Host-side draft quality checks: short warnings, never rejections
covers: src/planning/draftQualityChecks.ts#draftQualityWarnings, src/planning/draftQualityChecks.ts#extractReferencedPaths, src/extension/ops/planningConstraintChecks.ts#missingPathWarnings, src/extension/ops/planningConstraintChecks.ts#overlapWarnings, src/store/draftOverlap.ts#listOverlapCandidates

`planningOutbox.ts` runs these checks at ingest and on each revise. Each one only adds a WARNING (`@arch:DRAFT-CONSTRAINTS`). The planner gets the warnings back from `draft propose` (D782), so it can revise the draft before the human review.

- **Every warning is at most 60 chars** (`MAX_WARNING_CHARS`). A key, a path or a ref in a warning is clipped from the front by `clipToken`, so the sidebar card (`.pt-cwarn`, `flex: none`) never overflows. Do not add a warning that can be longer.
- **Text checks are pure** (`planning/draftQualityChecks.ts`, no I/O). They cascade so that one draft does not stack callouts: a session or agent plan path in the text (`$KARST_ARTIFACTS`, `planning-scratch/<id>/artifacts`, `~/.claude/plans/`, `.gemini/…/brain/`, `~/.codex/`, `docs/superpowers/plans/`, …; a repo path such as `docs/artifacts/spec.md` never matches); a description under 120 chars; a session plan artifact (a `.md` name in `<scratch>/artifacts`, read by name only) with a description under 300 chars, or under 500 chars with no path or no verification; the plan in the summary instead of the description; a duplicate description and summary (normalized equality, or both ≥ 400 chars with containment or a 4-word-shingle or line Jaccard ≥ 0.75; skipped when the plan-in-summary check fired); a summary under 80 chars; for a draft with repos, no path or no verification word in the description; a description over 12000 chars.
- **Paths.** `extractReferencedPaths` strips URIs, takes paths under the repo roots (`src/`, `tests/`, `docs/`, `.github/`, …) and drops globs and placeholders. A path is `created` (never checked) when its line has `[NEW]`, `(new)`, `new file`, `create `, `creating ` or `add `, or when it sits under a "New files" heading.
- **Paths at base.** For each distinct `repoPath` (`repoTargetsOf`), ONE async `git cat-file --batch-check` gets `<ref>^{commit}` for `origin/<base>`, `<base>` and `HEAD` and every `<ref>:<path>` line; the first ref that resolves wins. At most 50 paths; a `.js` path also matches its `.ts`/`.tsx` source. A path missing in every checked repo is reported (at most 3, then `+N more`). This probe and the commit probe share the one `checking` latch and write once (`verifyAsync`). A git failure skips the repo with a `[planning]` debug line.
- **Design keys.** `@arch:KEY` (`[A-Z0-9_-]`) is checked against `docs/arch/*.md` and `@ui:KEY` (`[A-Za-z0-9._-]`, for keys such as `@ui:1.1` and `@ui:UI-R09b`) against `docs/ui/*.md`. Use the bare key as the whole entry. A missing docs dir skips that namespace with a debug line.
- **Overlap.** `listOverlapCandidates` reads the pending drafts and the open, non-archived tickets (one light query, never `listTickets()`), minus the draft itself and everything linked to it through dependsOn or blocked-by, both ways. A candidate that shares 2+ source files (not `docs/**`, not `*.md`) or has a title Jaccard ≥ 0.65 (3+ tokens of 3+ chars, no stopwords, on both sides) gets a warning, at most 3. A store failure skips the check with a debug line.
END_DOC_BLOCK: [@arch:DRAFT-QUALITY]
```

- [ ] **Step 2: Edit the existing blocks**

1. `@arch:DRAFT-CONSTRAINTS` (`docs/arch/cli.md`): in the paragraph that starts `- **Checks are warnings, never rejections**`, change `Unknown \`@arch:KEY\` (not a \`[@arch:KEY]\` in any of the draft's repos' \`docs/arch/*.md\`)` to `Unknown \`@arch:KEY\` or \`@ui:KEY\` (not a \`[@arch:KEY]\` in any of the draft's repos' \`docs/arch/*.md\`, or a \`[@ui:KEY]\` in \`docs/ui/*.md\`)`. At the end of that paragraph, add the sentence: `The draft quality, path-at-base and overlap checks follow the same rule (\`@arch:DRAFT-QUALITY\`).`
2. `@arch:CLI-17` (`docs/arch/cli.md`): in the second bullet, change `When the async commit probe runs,` to `When an async probe (commit or path at base, \`@arch:DRAFT-QUALITY\`) runs,`.
3. `@arch:PLANNING` (`docs/arch/store-and-schema.md`): at the end of the paragraph that starts `**The session proposal index.**`, add: `The host reads only the file NAMES in \`<scratch>/artifacts\` (for the dropped-plan warning, \`@arch:DRAFT-QUALITY\`), never their content.`
4. `@arch:PLANNING-DEPS` (`docs/arch/store-and-schema.md`): before `END_DOC_BLOCK: [@arch:PLANNING-DEPS]`, add the line: `\`projectGraph\` and \`NEW_NODE\` are exported: the overlap check (\`store/draftOverlap.ts\`, \`@arch:DRAFT-QUALITY\`) reads the same graph to skip linked drafts and tickets.`

- [ ] **Step 3: Regenerate and check the docs**

Run, in this order:

```bash
npm run -s docs:index
npm run -s docs:covers
npm run -s docs:graph
npm run -s docs:check
npm run -s docs:graph -- --check
```

Expected: the last two exit 0. `git status --short docs` shows `docs/INDEX.md`, `docs/COVERS.json` and maybe `docs/arch/system-map.md` changed. If `docs:check` reports a block over the cap, shorten the sentence you added to that block; never raise the cap.

- [ ] **Step 4: Commit and run the docs gate**

```bash
git add docs/arch/cli.md docs/arch/store-and-schema.md docs/INDEX.md docs/COVERS.json docs/arch/system-map.md
git commit -m "docs(arch): document host-side draft quality checks (@arch:DRAFT-QUALITY)"
BASE_REF=develop PR_BODY= node scripts/docsGate.mjs
```

Expected: the gate exits 0. If it BLOCKs on a block whose `covers:` names a changed symbol, edit that block in a new commit. If the block still holds without an edit, run `karst arch cite @arch:KEY --why "<reason>"` (with `$KARST` expanded) instead.

- [ ] **Step 5: Final verification (no full suite in a karst ticket)**

Run:

```bash
npx vitest run src/planning/draftQualityChecks.test.ts src/extension/ops/planningConstraintChecks.test.ts src/store/draftOverlap.test.ts src/store/planningProposals.test.ts src/context/hostGitFree.test.ts
npx vitest run --config vitest.integration.config.ts src/extension/ops/planningOutbox.integration.test.ts src/extension/ops/planningConstraintChecks.integration.test.ts
npm run -s typecheck
npm run -s lint:layers
```

Expected: all exit 0.

---

## Spec coverage

| Spec item | Task |
|-----------|------|
| 1. `draftQualityChecks.ts`, `extractReferencedPaths`, warnings 1–9 | Task 1 |
| 2. `@ui:KEY` in `archWarnings`/`archDocFiles`, debug skip | Task 2 (Deviations 1, 2) |
| 2. `missingPathsViaGitBatch` + `missingPathWarnings`, dedupe by repoPath, `.js`→`.ts`, 50 paths, 3 + `+N more` | Task 3 (Deviation 3) |
| 2. `overlapWarnings`, exclusions, 2 files / 0.65 title, cap 3 | Task 4 (Deviations 4, 5) |
| 3. `hasPlanArtifact` sync readdir, light SQL, path probe with the D782 latch, extension wiring, `good` fixture | Task 5 |
| 4. Docs and graph | Task 6 |
| Acceptance: P73 213/226 fixtures, ≤ 60 chars, `docs/artifacts/spec.md`, `[NEW]`/`### New files`/`.js` | Tasks 1, 3 |
| Acceptance: ≤ 2 git processes per repoPath, zero `spawnSync` | Task 3 (1 process), Task 5 Step 7 |

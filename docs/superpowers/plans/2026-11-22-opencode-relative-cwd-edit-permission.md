# opencode relative-cwd edit permission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `opencode` and `opencode2` native `edit`/`write` tools write files inside `cwd` under `policy: 'gate'` and in a read-only planning `writableDir`.

**Architecture:** The CLI rewrites a path inside `cwd` to a relative resource string, so an absolute `${cwd}/**` allow never matches. The gate `edit` map starts with `'*': 'allow'`, then denies `/**`, `..` and `../**`, then re-allows the absolute roots, then denies the protected paths last. The read-only map adds the cwd-relative `<rel>/**` allow for a `writableDir` inside `cwd`.

**Tech Stack:** TypeScript (ESM), vitest.

**Spec:** Ticket FIX-AGENT-ALLOW-RELATIVE-CWD (planning brief D770).

## Global Constraints

- `opencode` v1 and `opencode2` share `opencodeLaunchPermission` and `opencodeGatePermission` (`@arch:AC-08`).
- The `opencode2` glob knows only `*` (`.*`) and `?` (`.`). The rule order is last-match-wins.
- Do not put `'**': 'allow'` after `'*': 'deny'`: `**` also matches every absolute path.
- Do not change the `bash` rules.

---

### Task 1: Gate edit map allows cwd-relative paths

**Files:**
- Modify: `src/agent/gatePolicy.ts` (`opencodeGatePermission`, new `tmpRoots`)
- Test: `src/agent/gatePolicy.test.ts`

- [x] **Step 1:** Write the failing tests: the key order `['*', '/**', '..', '../**', ...]`, and the `realpathSync(tmp)` root through a symlink.
- [x] **Step 2:** Run `npx vitest run src/agent/gatePolicy.test.ts`. Expect FAIL.
- [x] **Step 3:** Emit `'*': 'allow'`, `'/**': 'deny'`, `'..': 'deny'`, `'../**': 'deny'`, then `${cwd}/**`, `tmpRoots(tmp)`, `extraRoots`, then the protected paths.
- [ ] **Step 4:** Write a failing test that evaluates the map with an emulation of the `opencode2` matcher (anchored regex, `*`→`.*`, `?`→`.`, last match wins). Cases: `src/a.ts`, `package.json`, `.` allow; `/etc/passwd`, `..`, `../other/x` deny; `/wt/src/a.ts`, `/tmp/x` allow; `/h/.claude.json` deny; a protected dir inside `cwd` denied in its absolute and its relative form.
- [ ] **Step 5:** Also deny the cwd-relative form of each protected path inside `cwd` (`'*'` allow would otherwise re-open it).
- [ ] **Step 6:** Run the test file. Expect PASS.

### Task 2: Read-only `writableDir` relative allow

**Files:**
- Modify: `src/agent/opencode.ts` (`opencodeLaunchPermission`, new `writableEditRules`)
- Test: `src/agent/adapterConformance.test.ts`

- [x] **Step 1:** Change the conformance expectation to `[['*','deny'],['/karst/scratch/artifacts/**','allow'],['artifacts/**','allow']]`.
- [x] **Step 2:** Add an optional `cwd` to `opencodeLaunchPermission`. Emit `${relative(cwd, writableDir)}/**` when the dir is inside `cwd`.
- [ ] **Step 3:** Run `npx vitest run src/agent/adapterConformance.test.ts src/agent/gatePolicy.test.ts` and `npm run -s typecheck`. Expect PASS.
- [ ] **Step 4:** Update the `covers:` doc block if a covered symbol changed. Run `BASE_REF=develop PR_BODY= node scripts/docsGate.mjs` after the commit.
- [ ] **Step 5:** Commit `fix(agent): allow cwd-relative paths in opencode gate and writableDir edit permissions`.

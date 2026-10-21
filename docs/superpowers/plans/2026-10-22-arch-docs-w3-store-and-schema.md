# Arch Docs W3: Rewrite docs/arch/store-and-schema.md Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `docs/arch/store-and-schema.md` to conform to the `@arch:DOC-01` architecture template with an `@arch:ST-00` Overview block and comprehensive `covers:` mappings.

**Architecture:** Introduce `@arch:ST-00` containing required Purpose, Connections (citing in/out dependencies including `@arch:MAP-04`), Flow (Mermaid flowchart of caller -> transaction -> migrations/db), Tradeoffs, Fallbacks, and Rules list. Fold legacy `CONTENTS` block into ST-00, tag all rule blocks with verified `covers:` lines, and verify with docs lint, mermaid validation, and regenerated index/covers artifacts.

**Tech Stack:** Markdown, Mermaid 11.17.2, Node.js (`scripts/docsKeys.mjs`, `scripts/docsMermaid.mjs`).

**Spec:** Ticket ARCH-DOCS-W3-REWRITE-DOCS-ARCH prompt and `docs/arch/README.md` (`@arch:DOC-01`, `@arch:DOC-02`).

## Global Constraints

- Each docs/arch file gets ONE overview block `## [@arch:<PREFIX>-00] Overview` with prefix `ST` for `store-and-schema.md`.
- First line after heading may be `covers: <glob|file#symbol>, ...` (comma-separated, repo-relative).
- Required `### ` sections in -00, in this order: `Purpose`, `Connections`, `Flow`. Optional: `State`, `Tradeoffs`, `Fallbacks`, `Rules`.
- Purpose: 1–3 sentences. Connections: `- in:` / `- out:` bullets naming other `@arch:` keys. Tradeoffs: a `chosen|rejected|why` table. Fallbacks: a `trigger|behaviour|recovery` table. Rules: a ` · `-separated list of the file's rule keys.
- Flow is a single `mermaid` fence (flowchart or sequenceDiagram) and is the LAST fence in the block. Only a trailing `<!-- GENERATED:end -->` comment or block end may follow it; notes go above it.
- Rule blocks stay one statement: no `### ` sections, no diagram; optional `covers:` line.
- `MAX_BLOCK_BYTES` (6200) unchanged: if -00 would exceed, shorten prose, never split into sidecar blocks.
- Real paths only in `covers:` lines — every item must pass `node scripts/docsKeys.mjs covers --check` and lint.
- Do not rename existing rule keys. Do not duplicate rule text into -00; link keys.
- No `src/` runtime code changes — docs only.

---

### Task 1: Overview Block and Citation of @arch:MAP-04

**Files:**
- Modify: `docs/arch/store-and-schema.md:13-63`

**Interfaces:**
- Consumes: `@arch:DOC-01` template in `docs/arch/README.md`, `@arch:MAP-04` live ER in `docs/arch/system-map.md`.
- Produces: `@arch:ST-00` Overview block in `docs/arch/store-and-schema.md` meeting all section requirements and byte caps (< 6200 bytes).

- [x] **Step 1: Check existing block lint status before modification**

Run: `node scripts/docsKeys.mjs lint`
Expected: Output clean (exit code 0).

- [x] **Step 2: Ensure Connections section in ST-00 cites @arch:MAP-04**

In `docs/arch/store-and-schema.md`, ensure the `### Connections` section includes:
```markdown
- out: @arch:MAP-04 — live schema ER diagram and table relationships.
```
Specifically, the `### Connections` block should read:
```markdown
### Connections
- in: @arch:SINGLE-WRITER, @arch:EVIDENCE-WHEN — stage/agent-state and gate-evidence rules decide what may be written.
- in: @arch:BASE-PER, @arch:SPAWN-ENV — the base-ref and env-override semantics these columns carry.
- in: @arch:GH-03 — PR facts and merge shas arrive through `updatePrDetail`.
- out: @arch:CLI-05, @arch:CLI-08 — the CLI reads the same registry with `node:sqlite` and cannot migrate.
- out: @arch:DIAG-02 — reporting reads the run/token tables and never reaches back.
- out: @arch:MAILBOX — v77 keeps fix rows out of the shared message route.
- out: @arch:MAP-04 — live schema ER diagram and table relationships.
```

- [x] **Step 3: Verify ST-00 block byte limit and structure**

Run:
```bash
node -e '
const fs = require("fs");
const text = fs.readFileSync("docs/arch/store-and-schema.md", "utf8");
const match = text.match(/## \[@arch:ST-00\][\s\S]*?END_DOC_BLOCK: \[@arch:ST-00\]/);
const bytes = Buffer.byteLength(match[0], "utf8");
console.log("ST-00 bytes:", bytes);
if (bytes > 6200) process.exit(1);
'
```
Expected: `ST-00 bytes: < 6200` and exit code 0.

- [x] **Step 4: Run doc linter to verify section order and structure**

Run: `node scripts/docsKeys.mjs lint`
Expected: Output clean (exit code 0).

- [x] **Step 5: Commit changes**

```bash
git add docs/arch/store-and-schema.md
git commit -m "docs(arch): cite @arch:MAP-04 in store-and-schema ST-00 connections"
```

---

### Task 2: Audit and Verify covers: Annotations

**Files:**
- Modify: `docs/arch/store-and-schema.md`
- Inspect: `src/store/**`, `src/cli/assertMigrated.ts`, `src/recovery/reconcile.ts`, `src/project/**`

**Interfaces:**
- Consumes: `docs/arch/README.md` (`@arch:DOC-02` grammar for `covers:`).
- Produces: Validated `covers:` lines on all blocks in `docs/arch/store-and-schema.md`.

- [x] **Step 1: Verify all symbol and glob targets exist**

Run: `node scripts/docsKeys.mjs covers --check`
Expected: Passes with no missing files, empty globs, or unrecognized symbols.

- [x] **Step 2: Verify all rule blocks have covers lines**

Verify that all blocks in `docs/arch/store-and-schema.md` are covered:
- `ST-00`: `src/store/**, src/cli/assertMigrated.ts#assertExactSchema, src/cli/assertMigrated.ts#assertMigratedSchema`
- `SQLITE`: `src/recovery/reconcile.ts#reconcileOnStart, src/recovery/reconcile.ts#deriveStageCurrent`
- `PROJECTS`: `src/project/bind.ts#bindProject, src/project/slug.ts#resolveProjectSlug`
- `GLOBAL`: `src/agent/settings.ts#writeHookSettings, src/agent/settingsSweep.ts`
- `GRAPHRUN`: `src/store/graph/**`
- `SHELF`: `src/model/artifacts.ts`
- `BASEBRANCH`: `src/workflow/changeBaseRef.ts#changeBaseRef, src/store/worktrees.ts#takeForcePushLease`
- `ENVOVR`: `src/store/ticketEnvOverrides.ts#setServiceEnvOverrides`
- `WORKTREES-ROW`: `src/runtime/worktree.ts#createWorktree`
- `V64`: `src/store/ticketMessagesRepair.ts#repairTicketMessages`
- `PLANNING`: `src/store/planningSessions.ts, src/store/planningProposals.ts, src/extension/ops/planningOutbox.ts`
- `RELATIONS`: `src/store/ticketRelations.ts`
- `BULLETIN`: `src/store/bulletinNotes.ts#recordTicketMerged, src/model/bulletinRelevance.ts`
- `V77`: `src/store/fixDeliveries.ts#upsertFixDelivery`
- `V82`: `src/store/usageLimitParks.ts, src/store/stageBlocks.ts#parkGateStage, src/store/stages.ts#setStage`
- `SCHEMA-CHECK`: `src/store/schema.sql, src/store/migrations.ts#migrate, src/store/schemaVersion.ts#SCHEMA_VERSION`

- [x] **Step 3: Run covers validation check**

Run: `node scripts/docsKeys.mjs covers`
Expected: Updates `docs/COVERS.json` without errors.

---

### Task 3: Reindex Documentation and Regenerate Covers

**Files:**
- Modify: `docs/INDEX.md`
- Modify: `docs/COVERS.json`

**Interfaces:**
- Consumes: `docs/arch/store-and-schema.md` keys and `covers:` definitions.
- Produces: Up-to-date `docs/INDEX.md` and `docs/COVERS.json`.

- [x] **Step 1: Regenerate index**

Run: `npm run -s docs:index`
Expected: `docs/INDEX.md` updated with `@arch:ST-00` and all store rule keys.

- [x] **Step 2: Regenerate covers map**

Run: `npm run -s docs:covers`
Expected: `docs/COVERS.json` updated with all mapped symbols and globs.

- [x] **Step 3: Check diffs on generated files**

Run: `git diff docs/INDEX.md docs/COVERS.json`
Expected: Only expected changes or clean if already synchronized.

- [x] **Step 4: Commit generated documentation changes**

```bash
git add docs/INDEX.md docs/COVERS.json
git commit -m "docs: regenerate INDEX.md and COVERS.json for ST-00"
```

---

### Task 4: Complete Verification Suite

**Files:**
- Verify: `docs/arch/store-and-schema.md`
- Verify: `docs/INDEX.md`
- Verify: `docs/COVERS.json`

**Interfaces:**
- Consumes: Entire documentation set under `docs/arch/`.
- Produces: Green CI checks for `docs:check` and `docs:mermaid`.

- [x] **Step 1: Run docs lint, index check, and covers check**

Run: `npm run -s docs:check`
Expected:
```
> karst@1.0.0 docs:check
> node scripts/docsKeys.mjs lint && node scripts/docsKeys.mjs index --check && node scripts/docsKeys.mjs covers --check
```
Exit code 0.

- [x] **Step 2: Run mermaid parsing validation**

Run: `npm run -s docs:mermaid`
Expected:
```
> karst@1.0.0 docs:mermaid
> node scripts/docsMermaid.mjs
```
Exit code 0.

- [x] **Step 3: Verify git status is clean**

Run: `git status`
Expected: `nothing to commit, working tree clean`.

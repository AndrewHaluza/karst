# Arch Docs W3: Rewrite docs/arch/cli.md Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `docs/arch/cli.md` to conform to the `@arch:DOC-01` architecture template with an `@arch:CLI-00` Overview block and comprehensive `covers:` mappings.

**Architecture:** Introduce `@arch:CLI-00` containing required Purpose, Connections (in/out dependencies), Flow (Mermaid sequence diagram of agent terminal / MCP -> CLI -> outbox/IPC -> extension host -> store), Tradeoffs, Fallbacks, and Rules list. Fold legacy CLI-01 Contents block into CLI-00, tag all rule blocks with verified `covers:` lines, update CLI-01 citation to CLI-00 in `docs/arch/system-map.md`, and verify with docs lint, mermaid validation, and regenerated index/covers artifacts.

**Tech Stack:** Markdown, Mermaid 11.17.2, Node.js (`scripts/docsKeys.mjs`, `scripts/docsMermaid.mjs`).

**Spec:** Ticket ARCH-DOCS-W3-REWRITE-DOCS-ARCH-b prompt and `docs/arch/README.md` (`@arch:DOC-01`, `@arch:DOC-02`).

## Global Constraints

- Each docs/arch file gets ONE overview block `## [@arch:<PREFIX>-00] Overview` with prefix `CLI` for `cli.md`.
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

### Task 1: Overview Block and Citation of @arch:CLI-00

**Files:**
- Modify: `docs/arch/cli.md`
- Modify: `docs/arch/system-map.md`

- [x] **Step 1: Check existing block lint status before modification**
- [x] **Step 2: Add CLI-00 Overview block to docs/arch/cli.md and fold CLI-01 Contents**
- [x] **Step 3: Update system-map.md line 26 citation from CLI-01 to CLI-00**
- [x] **Step 4: Verify CLI-00 block byte limit (< 6200 bytes, currently 5201 bytes)**
- [x] **Step 5: Run doc linter to verify section order and structure**

---

### Task 2: Audit and Verify covers: Annotations

**Files:**
- Modify: `docs/arch/cli.md`
- Inspect: `src/cli/**`, `src/approaches/phaseName.ts`, `src/agent/cliEnv.ts`, `src/model/ticketMessaging.ts`, `src/planning/proposal.ts`, `src/extension/ops/planning*.ts`, `src/store/blockerOutcome.ts`, `src/doctor/applyFixes.ts`

- [x] **Step 1: Verify all symbol and glob targets exist**
- [x] **Step 2: Tag all rule blocks with verified covers: lines**
- [x] **Step 3: Run covers validation check**

---

### Task 3: Reindex Documentation and Regenerate Covers

**Files:**
- Modify: `docs/INDEX.md`
- Modify: `docs/COVERS.json`

- [x] **Step 1: Regenerate index (`npm run -s docs:index`)**
- [x] **Step 2: Regenerate covers map (`npm run -s docs:covers`)**
- [x] **Step 3: Verify with docs:check and docs:mermaid**

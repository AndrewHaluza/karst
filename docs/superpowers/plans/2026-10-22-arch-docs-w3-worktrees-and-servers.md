# Arch Docs W3: Rewrite docs/arch/worktrees-and-servers.md Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `docs/arch/worktrees-and-servers.md` to conform to the `@arch:DOC-01` architecture template with an `@arch:WT-00` Overview block and comprehensive `covers:` mappings.

**Architecture:** Introduce `@arch:WT-00` containing required Purpose, Connections (citing in/out dependencies across manifest, store, stages, and map docs), Flow (Mermaid sequence diagram of worktree lifecycle from scope -> createWorktree -> spin -> port allocation -> supervisor -> health check), Tradeoffs, Fallbacks, and Rules list. Fold legacy `CONTENTS` block into WT-00, tag all rule blocks with verified `covers:` lines, and verify with docs lint, mermaid validation, and regenerated index/covers artifacts.

**Tech Stack:** Markdown, Mermaid 11.17.2, Node.js (`scripts/docsKeys.mjs`, `scripts/docsMermaid.mjs`).

**Spec:** Ticket ARCH-DOCS-W3-REWRITE-DOCS-ARCH-a prompt and `docs/arch/README.md` (`@arch:DOC-01`, `@arch:DOC-02`).

## Global Constraints

- Each docs/arch file gets ONE overview block `## [@arch:<PREFIX>-00] Overview` with prefix `WT` for `worktrees-and-servers.md`.
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

### Task 1: Add WT-00 Overview Block and Fold CONTENTS

**Files:**
- Modify: `docs/arch/worktrees-and-servers.md`

**Interfaces:**
- Consumes: `@arch:DOC-01` template in `docs/arch/README.md`.
- Produces: `@arch:WT-00` Overview block in `docs/arch/worktrees-and-servers.md` meeting all section requirements and byte caps (< 6200 bytes), deleting legacy `CONTENTS` block.

- [x] **Step 1: Write WT-00 overview block with Purpose, Connections, Flow, Tradeoffs, Fallbacks, and Rules**
- [x] **Step 2: Fold CONTENTS list into WT-00 Rules and remove CONTENTS block**
- [x] **Step 3: Verify WT-00 byte count <= 6200 bytes**
- [x] **Step 4: Run doc linter to verify section order and structure**

---

### Task 2: Tag All Rule Blocks with covers: Mappings

**Files:**
- Modify: `docs/arch/worktrees-and-servers.md`
- Inspect: `src/runtime/**`, `src/store/**`, `src/workflow/**`, `src/template/**`, `src/resolver/**`, `src/agent/**`

**Interfaces:**
- Consumes: `docs/arch/README.md` (`@arch:DOC-02` grammar for `covers:`).
- Produces: Validated `covers:` lines on all blocks in `docs/arch/worktrees-and-servers.md`.

- [x] **Step 1: Add area globs to WT-00 covers**
- [x] **Step 2: Add verified file#symbol targets to each rule block**
- [x] **Step 3: Validate covers with lintCovers**

---

### Task 3: Reindex Documentation and Regenerate Covers

**Files:**
- Modify: `docs/INDEX.md`
- Modify: `docs/COVERS.json`

**Interfaces:**
- Consumes: `docs/arch/worktrees-and-servers.md` keys and `covers:` definitions.
- Produces: Up-to-date `docs/INDEX.md` and `docs/COVERS.json`.

- [x] **Step 1: Regenerate index (`npm run docs:index`)**
- [x] **Step 2: Regenerate covers map (`npm run docs:covers`)**
- [x] **Step 3: Verify docs:check and docs:mermaid pass**

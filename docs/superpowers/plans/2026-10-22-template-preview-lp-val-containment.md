# Template preview .lp-val containment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `span.lp-val` overflowing `div.template-preview` by ~5.5px at 480px on Settings `#git`.

**Architecture:** One CSS rule. The inline mono span breaks at any character, so its box cannot exceed a squeezed parent by one glyph.

**Tech Stack:** Settings webview CSS, Playwright layout and visual gates (docker).

**Spec:** ticket FIX-DEVELOP-S-LAYOUT-GATE-FAILS; @ui:UI-R43, UI-R44, UI-R45.

## Global Constraints

- Do not re-add ledger entries or loosen containment tolerance.
- No baseline edits.

---

### Task 1: Span wraps at any character

**Files:**
- Modify: `src/ui/settings/webview.html` (`.template-preview .lp-val`)

- [x] **Step 1:** Add `word-break:break-all;overflow-wrap:anywhere` to `.template-preview .lp-val`.
- [x] **Step 2:** `npm run -s test:layout:docker` → 74 passed, ledger verdict passes.
- [x] **Step 3:** `npm run -s test:visual:docker` → 833 passed, no baseline churn.
- [x] **Step 4:** Commit.

**Note:** the failure did not reproduce on develop in docker before the change (both gates were already green), so this is a defensive fix for the one-glyph overshoot. The T726 attempt-3 log was never available to compare environments.

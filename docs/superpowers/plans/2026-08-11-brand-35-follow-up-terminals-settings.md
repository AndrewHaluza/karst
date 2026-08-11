# Brand #35 Follow-up — Terminals + Settings Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the two remaining brand-#35 surfaces flagged in 869egvp46-fu2: agent terminal tabs (icon must be the status-free full-color mark, not a status-tinted silhouette) and the settings sidebar brand mark (still the letter badge, must be the approved mark).

**Architecture:** Both changes follow the pattern established in the original brand ticket: status-free surfaces use the full-color approved #35 mark (gradients baked into the SVG), and the webviews embed the mark as an inline SVG (self-contained documents, CSP forbids external assets). The terminal naming decision moves into a small vscode-free module so the "no status colors on terminals" rule is testable, mirroring how `brandIconPaths`/`glyphIconPath` already split status-free vs status-tinted marks.

**Tech Stack:** TypeScript, VS Code extension API (`Terminal.creationOptions` is readonly — name/icon/color frozen at creation), vitest, inline-SVG webview branding.

## Global Constraints

- Approved #35 geometry is canonical: `M 96 20 …` left shell, `M 151 42 …` right shell, core `cx="106.5" cy="111.5" r="26.5"`. Never reinterpret; no mountain motif.
- Gradient stops (from `media/karst.svg`): left `#7D48E9/#7D3CEE/#4A71D7`, right `#00B7C9/#00AFC0/#00B1C4`, core `#6647DE/#5660D9/#3586D6`.
- Terminals carry NO status color and NO glyph-tinted icon: the tab look is frozen at creation, so a status hue would be the stage-at-launch forever (869egvp46-fu2).
- Dashboard/ticket-form tab repaints and sidebar row markers KEEP their status glyph tint — only terminals change.
- Webviews are self-contained; no external asset references. Inline SVG defs must use unique gradient ids per webview.
- No raw hex/rgb/px/rem literals in `<style>` blocks (UI-R04) — the SVG gradients live in the body markup, as in gettingStarted.

---

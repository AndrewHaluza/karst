# Ticket form: derive provider label and badge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans.

**Goal:** The ticket form's "create in <provider>" control takes its name and mark from the shared provider identity, with no `ClickUp` literal in `webview.html`.

**Architecture:** Add `providerLabelText(provider)` to the injected identity JS (`providerIdentity.ts`) and reuse it inside `providerBadgeHtml`. `renderCreateIn` fills `#createInName` / `#createInBtnName` with `providerBadgeHtml(state.provider)` and sets the `title` attributes from the plain label. Gating (`canCreateProviderTicket`, `ticketSearchEnabled`) is untouched.

**Tech Stack:** TypeScript, vitest + jsdom render harness.

**Spec:** ticket TICKET-FORM-DERIVE-PROVIDER (D285); ui:UI-R31, ui:UI-R57, ui:ICONS-05.

## Global Constraints
- No per-provider if/else in the webview (ui:UI-R31); no new logo-key API.
- Manual: no switch, no badge.

### Task 1: Derive create-in control from identity
**Files:** modify `src/model/providerIdentity.ts`, `src/ui/ticketForm/webview.html`; test `src/ui/ticketForm/webview.createin.render.test.ts`, `src/model/providerIdentity.test.ts`; variant in `tests/visual/variants.ts`.
- [x] Write failing render tests (clickup switch/button, manual, unmarked provider, gating, no-literal source check).
- [x] Add `providerLabelText`; replace literals in label, titles, comments; fill badge in `renderCreateIn` only when creatable.
- [x] Add `clickup-create-in` visual variant.
- [x] Run `npx vitest run src/ui/ticketForm src/model/providerIdentity.test.ts`, typecheck, commit.

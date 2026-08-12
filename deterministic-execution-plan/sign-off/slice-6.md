# Slice 6 Sign-off — Optional Transport and Observability Extensions

Date: 2026-08-12

Commit range: `2364ee1` (T1) … `eb67fff` (T4), five commits (T3's host-seam
fix `c21ddca` included).

## Entry gate

Slice 5 exit gate holds (sign-off recorded `b173cb5`).

## Exit gate

- `npm run typecheck` ✓ (clean)
- `npm test` ✓ — 377 test files, 6632 tests
- `npm run build` ✓
- Coordinator/marker diff check (K4): the five scheduler-semantics files
  named by the binding constraint — `coordinator/claim.ts`, `conflicts.ts`,
  `lineage.ts`, `replan.ts`, `workflow/graphMarkerGuard.ts` — have **zero
  diff** across the whole slice. The `coordinator/` files that DO appear
  (sweep, completion, recovery, visits, repair, pipeline) are the Slice-6 T3
  diagnostic-emitter call sites — task-named (`diagnostics.ts`,
  `logging/logger.ts` call sites), additive logging only, no control-flow or
  scheduler-semantics change; each existing debug line was replaced in place
  at the same decision point.

## Invariant checklist rows gated at Slice 6, with their proving tests

| # | Invariant | Proving test (file — title) |
|---|---|---|
| C7 | No capability in argv, URLs, logs, diagnostics, artifacts, UI, or issue reports | `src/approaches/graph/diagnostics.test.ts` — "redacts a capability, a prompt body, and a secret-shaped value from every emitted line"; the ACP transport persists only the owner-nonce hash, never the capability (`src/approaches/graph/transport/acpTransport.test.ts` lifecycle tests) |
| F8 | Contrast verified in light, dark, high contrast (UI-R29) | the T4 node-list surface uses the shared token ramp (status groups via `--k-*`); the pinned contrast tests (`src/model/designSystem.test.ts`) stay green; no new color literal |
| F9 | Every graph-derived string escaped; ANSI and unsafe schemes stripped; CSP authoritative | `src/ui/dashboard/webview.test.ts` — "escapes every node-list string through the one webview escaper"; `src/model/inside/graph.test.ts` — "escapes the injection fixture at every new node-list surface" (ANSI/`javascript:`/`data:`/control stripped at the model AND the webview); every new string passes `sanitizeGraphText` + `esc` |
| K1 | Diagnostics carry closed categories and bounded keys; agent prose is bounded before logging | `diagnostics.test.ts` — "emits every closed category with its full key set"; "bounds the line under an adversarially long agent reason"; "collapses multi-line and control-char detail into one bounded line"; the closed `GraphDiagnosticCategory` union with the `never` exhaustiveness |
| K2 | No capability, prompt body, secret, or unredacted command output in any log, diagnostic, or issue report | `diagnostics.test.ts` — "redacts a capability, a prompt body, and a secret-shaped value from every emitted line"; the line passes `sanitizeText` (the buffer's redaction pipeline) before the callback; the Inside copy-diagnostic surface is the same bounded/redacted source (`src/model/inside/graph.ts` diagnostic-log rows re-escaped) |
| K3 | Host-agnostic modules receive `debug` as an injected callback, never importing the logger | `src/approaches/graph/graphLoggerImport.test.ts` — "no reachable graph import lands on src/logging/logger" (walks every `src/approaches/graph` module's import graph); `diagnostics.ts` imports only the leaf `redact.ts` |
| K4 | Slice 6 changes no scheduler semantics (empty coordinator/marker diff) | the five binding-constraint files have zero diff; the coordinator diff is the T3 diagnostic wiring only (documented above) |

## Cross-slice invariants re-verified green by the full suite

1. The scheduler/semantics files are byte-identical to Slice 5 (K4).
2. C1–C10 untrusted input: the ACP transport adds no argv/token surface; its boundary refusals (peer delegation, non-loopback endpoint) are closed pure functions.
3. F1–F9 UI: the new node-list composition is local (unprefixed `.graph-nodes`), the override-edit control rides the same typed-action seam, the discard stays the only danger-variant control, strings escape at model AND webview.
4. H accounting: the usage rollup joins through the run rows — no `token_usage` column added, SQL `GROUP BY` off the existing indexes (proven by the `EXPLAIN QUERY PLAN` pin in `src/store/tokenUsage.test.ts`).
5. K1–K5 observability: closed categories, bounded prose, redaction-pipeline-clean, injected-debug only, command logs stay sensitive evidence.

## Non-graph test modifications

None outside the graph surface. `src/store/tokenUsage.test.ts`, `src/ui/usage/*`, `src/model/inside/graph.test.ts`, `src/ui/dashboard/webview.test.ts` gained cases (added, not changed). No schema/version change in this slice.

## Notes

- ACP (T1) ships as a V1-optional transport with a closed empty support set
  (`acpSupportedFor` returns none), a thin injected client seam, and the
  strict termination-only event boundary; a core without ACP keeps
  `SupervisedCLITransport`.
- The `close` and `launch` diagnostic categories' host seams are bound in
  `extension.ts` (`debug` to `flipOnEndQuiescence`, `graphIdentityOf` to the
  supervised transport) so all ten categories emit in production.
- The override-edit control's host deep-link is a documented stub that
  reports the intended node/profile/prompt/command editor location; the
  override WRITE stays behind the store's claim CAS.
- With Slices 1–6 signed off, the remaining binding obligation is the
  post-Slice-3 measurement on the first N completed real graph-approach
  tickets (Slice 6's entry gate made it evaluable; the abandonment criterion
  is recorded in `measurement/post-slice-3.md`).

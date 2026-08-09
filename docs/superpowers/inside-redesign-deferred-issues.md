# Inside Redesign Deferred Issues

Date: 2026-08-09

All reviewed Critical, High, and selected high-impact/moderate-effort Medium code findings are fixed. The following work is intentionally deferred and must not be inferred complete from automated tests.

## 1. Task 16 Manual Extension Development Host Matrix

Status: **Acceptance-blocking manual verification remains pending.**

Authoritative checklist: `docs/superpowers/verification/2026-08-08-inside-preview-matrix.md`.

The preview, deterministic fixture matrix, responsive source guards, VM renderer tests, command-palette development guard, and active → completed → cleared lifecycle controls are implemented. However, no named tester has observed every scenario at 2/5/10/15/20 repositories and 300/360/430/normal widths in a real Extension Development Host. Keyboard focus, reduced motion, real CSS overflow, and production-versus-fixture behavior therefore remain unverified.

Required closure evidence:

- Run **Karst: Open Inside Preview (Development)** in the Extension Development Host.
- Complete every unchecked matrix cell with tester/date/version/platform metadata.
- Record keyboard disclosure and nested-action focus behavior, reduced-motion behavior, long-content wrapping/overflow, live lifecycle updates, reopen/refresh behavior, and one real production ticket.
- Leave failed cells unchecked and file their reproduction details.

## 2. Upgraded-v32 Ship CHECK-Constraint Parity

Status: **Deferred Medium durability hardening.**

Fresh schema tables constrain Ship step/status/origin vocabularies, while databases upgraded from v32 do not receive equivalent table-level `CHECK` constraints. Current typed production writers emit only valid closed values, so this is not a known user-path corruption bug; correcting it requires risky SQLite table rebuilds and deserves an isolated migration review.

Required closure work:

- Add a forward migration rebuilding affected Ship evidence tables with fresh-schema-equivalent `CHECK` clauses.
- Migrate a real v31/v32-shaped database and prove existing evidence is preserved.
- Test rejection of every invalid step, status, and origin after upgrade.
- Verify valid values, foreign keys, `PRAGMA foreign_key_check`, indexes, and fresh/upgraded table-SQL parity.

## Verification State at Deferral

- Full Vitest suite: 306 files, 5,058 tests passed before the final two presentation corrections.
- Selected-fix follow-up: 178 focused tests passed.
- Scoped re-review: safe to push, zero residual findings above 80% confidence.
- Typecheck and diff checks passed after the final follow-up.

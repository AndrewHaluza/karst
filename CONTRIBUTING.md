# Contributing to Karst

Thanks for your interest. This document covers the two things that block a
merge: the CLA, and the project's conventions.

## 1. Sign the CLA

**Every contribution requires a signed [Contributor License Agreement](CLA.md).**

You keep the copyright in your work. You grant permission to use it, including
under future commercial terms. The reasoning is in [CLA.md](CLA.md#why-this-is-required).

Open a pull request and a bot will comment with a signing link. You sign once;
it covers all future pull requests.

Pull requests without a signed CLA cannot be merged, regardless of quality.
Please sign before investing real effort.

## 2. Before you start

**Open an issue first** for anything beyond a small fix. Karst has strong
architectural invariants, and a PR that breaks one will be rejected no matter
how good the code is. A short discussion up front saves you rework.

Good first contributions: bug fixes with a failing test, documentation
corrections, adapter support for an additional agent CLI.

## 3. Architecture invariants

These are binding. Read the reference document covering what you are touching
**before** you change it:

| Area | Document |
|---|---|
| Stages, gates, the driver | `docs/arch/stages-and-gates.md` |
| Agent cores and adapters | `docs/arch/agent-cores.md` |
| The `karst` CLI | `docs/arch/cli.md` |
| Worktrees, branches, servers | `docs/arch/worktrees-and-servers.md` |
| Store and schema | `docs/arch/store-and-schema.md` |
| GitHub and merge | `docs/arch/github-and-merge.md` |
| Manifest and Settings | `docs/arch/manifest-and-settings.md` |
| Diagnostics | `docs/arch/diagnostics.md` |
| Native ABI (better-sqlite3) | `docs/arch/ABI.md` |
| UI rules | `docs/ui/UI-RULES.md` |

The four that break most pull requests:

- **Host-agnostic core.** Logic takes injected interfaces. `vscode` is not a
  runtime dependency — only `@types/vscode` as a dev dependency. Anything that
  imports `vscode` goes in a thin binding layer; the testable logic goes in a
  `vscode`-free module.
- **SQLite is the source of truth.** All stage mutation through `setStage`,
  all agent state through `setAgentState`. Single writer.
- **Verdicts are deterministic.** Exit codes, never an agent's self-report.
  `null` never transitions, and a missing edge throws.
- **Never block the extension host event loop.** `spawnSync` is banned on any
  gate path.

## 4. Development

```bash
npm install
npm run typecheck      # tsc --noEmit
npm run test:unit      # vitest; rebuilds better-sqlite3 for the Node ABI
npm run test:e2e       # vitest with vitest.e2e.config.ts
npm run build          # compile + copy webview assets into dist/
```

Single test: `npx vitest run src/path/to.test.ts`

Press F5 in VS Code to launch the Extension Development Host. This rebuilds
the native addon for Electron's ABI; `npm run test:unit` rebuilds it for
Node's. That switch is automatic — see `docs/arch/ABI.md` if it misbehaves.

Never run `npx vitest run --coverage` directly; it skips the rebuild and
produces thousands of spurious `openStore` failures. Use `npm run test:coverage`.

## 5. Code conventions

- **Strict TDD.** Write the failing test first (RED), then the minimal
  implementation (GREEN). Pull requests adding behaviour without a test that
  fails before the change will be asked for one.
- **Keep files small.** Under 400 lines typical.
- **ESM.** Imports need the `.js` suffix. `moduleResolution: Bundler`.
- **`noUncheckedIndexedAccess` is on.** Array access needs a guard or `!`.
- **Edit source assets, never the `dist/` copies.** `scripts/copy-assets.mjs`
  mirrors the webview HTML files and `karst.example.yml` into `dist/`.
- **Command logic lives in `src/extension/ops/`** behind a `Notify` seam.
  `extension.ts` handlers are bindings only. A ratchet test enforces both the
  line ceiling and the absence of `vscode` imports under `ops/`.
- **Debug logging.** Every new stage runner, gate, or agent adapter needs
  `logger.debug()` at entry, decision branch, and exit. Host-agnostic modules
  receive `debug` as an injected callback — never import the logger. Never log
  secrets, tokens, full prompts, or repository contents.

## 6. The `karst` CLI while developing

The agent-facing CLI (`dist/cli/main.js`, run with plain `node` so it never
loads the Electron-ABI addon) carries verbs useful during development:
`context`, `stats`, `guide`, `servers`, `env`, `compact`, `fix-brief` and
`conflict-brief`, alongside the workflow verbs `stage`, `phase`, `graph` and
`node`.

`stage` is deliberately narrowed to `stage <impl|fix> pass` — `uat`, `review`
and `ship` are refused. That narrowing is a security property, not an
oversight: the agent reads ticket content it did not author, so prompt injection
reaches argv, and each verb is parsed in a separate path so a forged
`stage ship pass` cannot be constructed. **Do not widen it** without reading
[`docs/arch/cli.md`](docs/arch/cli.md) first.

### `karst test` — development only

There is also a `karst test` driver that **bypasses gate verdicts entirely**. It
can set a stage directly, inject a verdict, mark a PR merged, and reset the
registry.

It exists to drive the stage machine in development without waiting on real
gates. It is not a user feature and is deliberately absent from the README.
Using it against a registry you care about will produce ticket state that no
gate ever justified — which is precisely the property the rest of the system
exists to prevent. Point it at a scratch database.

## 7. Commits and pull requests

Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`,
`chore:`, `perf:`, `ci:`.

When a change exists to satisfy a UI rule, cite the rule id in the commit
message (UI-R35).

CI runs typecheck, build, unit tests, and e2e tests on every pull request to
`main` and `develop`. All are blocking. A mutation-score job runs advisory
and never fails the check.

Target `develop`, not `main`.

## 8. Licensing of your contribution

Karst is distributed under the [Business Source License 1.1](LICENSE), which
converts to Apache 2.0 on the Change Date. It is source-available, not
OSI-approved open source.

Your contribution is licensed to the project under the terms of [CLA.md](CLA.md).
Contributions are accepted only under those terms.

## 9. Reporting security issues

Do not open a public issue for a security vulnerability. Use GitHub's private
vulnerability reporting — see [SECURITY.md](SECURITY.md) for the process and
for the areas where reports are most welcome.

---
name: model-catalog-updates
description: How to add a new LLM model to karst's model catalog — the two copies that must stay in sync, the entry field rules, which core an id belongs to, how to check that core accepts it, and the tests that pin it
---

# Adding a model to the karst model catalog

Vendors ship new models regularly, and the change is the same every time: two
files, one support check per core, one test run. Worked example: NDL-154 /
NDL-156 added `claude-sonnet-5-5`.

## Where the catalog lives

Two copies of one curated list:

| Copy | File | Role |
| --- | --- | --- |
| Bundled | `src/agent/modelCatalog.ts` — `BUNDLED_CATALOG` | Offline fallback every install has; re-exported flat as `KNOWN_MODELS` in `src/agent/models.ts`. |
| Published feed | `model-catalog.json` (repo root) | The artifact an operator publishes and points `feedUrl` at. There is no default URL, so nothing fetches it unless configured. |

**Both must stay identical.** `src/agent/modelCatalog.test.ts` pins them with
the test `matches the published model feed exactly`, which compares
`parseModelFeed(model-catalog.json)` against `bundledModelCatalog()`. Edit one
copy and not the other and that test fails — that is the whole invariant.

Each copy carries four provider sections: `claude`, `codex`, `antigravity`,
`opencode` (`AgentProvider` in `src/manifest/types.ts`).

The pickers render the catalog the host supplies (`state.models`); no model
list is mirrored into any webview HTML. Do not add a model id to a `.html`.

## Tiers — where your edit lands

A provider's list resolves in order `cli → feed → cache → bundled`
(`src/agent/modelCatalogLoader.ts`, described in `docs/arch/agent-cores.md`):

- **cli** — live discovery; see "Check the core first" below.
- **feed** — `model-catalog.json`, only when the operator set `feedUrl`.
- **cache** — the last successful discovery. Derived data; never hand-edit it.
- **bundled** — `BUNDLED_CATALOG`. The default for every install.

So a hand-added model lands in the **bundled** tier and must be mirrored into
`model-catalog.json` so the **feed** tier carries the same row. Nothing else
needs touching: the cache rewrites itself and the CLI tier is discovered at
runtime.

## Which core, and where in its list

- Put the id in **exactly one** provider section: the core whose CLI accepts
  that exact `--model` value. `providers` is what
  `isModelCompatibleWithProvider` (`src/agent/models.ts`) checks — a wrong
  section makes the id drop when a ticket or a preset slot switches core
  (preset slots are atomic core/model/effort triples).
- **Order: newest and most capable first, families grouped.** Insert the new
  row next to its siblings (`claude-sonnet-5-5` sits with the Sonnet rows) and
  leave unrelated rows alone.
- **`opencode` stays empty.** `src/agent/modelCatalog.test.ts` pins
  `catalog.opencode` to `[]`: opencode ids are account- and provider-dependent,
  so the curated list is deliberately empty. Do not add ids there because they
  look plausible — the `cli` tier discovers them with `opencode models`.

## Entry fields

| Field | Rule | Source |
| --- | --- | --- |
| `id` | The exact `--model` value the CLI accepts. Must match `^[A-Za-z0-9][A-Za-z0-9._:/~-]{0,127}$` — no spaces, 128 chars max — and be unique within its provider (a duplicate id invalidates the whole section). | `MODEL_ID` in `src/agent/modelCatalog.ts` |
| `label` | 1–160 chars after trim, no control characters. Shown in the picker; it need not be unique — the id is what is deduplicated. | `validateModelList` |
| `providers` | `['<core>']` in `BUNDLED_CATALOG`. **Omit it in `model-catalog.json`** — the section key implies it and `validateModelList` fills it in. | `validateModelList` |
| `efforts` | Optional. Present: non-empty, unique, each matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. **Absent: the model accepts no effort** — a configured effort is then a Save-time failure (`EffortError`, `src/agent/effort.ts`), never silently dropped. Copy the effort shape of the model's own tier, not of a neighbour (today's Opus 5.x rows carry `low`…`ultracode`, Sonnet 5 carries `low`/`medium`/`high`, and older rows such as Sonnet 4.6 carry none). | `EFFORT_VALUE` |
| `tags` | Optional, closed vocabulary: `multimodal`, `text-only`, `audio`, `vision`. Unique. Absent means "capabilities unknown". | `MODEL_TAGS` |

`model-catalog.json` also needs `"version": 1` at the root — any other version
makes `parseModelFeed` reject the whole feed.

## Check the core first

karst does not validate an id before launch. Every adapter passes `--model`
through verbatim (`src/agent/claude.ts`, `src/agent/codex.ts`,
`src/agent/opencode.ts`, `src/agent/antigravity.ts`; all four declare
`model: SUPPORTED` and `exactModel: SUPPORTED` in `src/agent/surfaces.ts`).
An id the vendor rejects comes back as a 400/404 naming the model, which
`src/agent/failureClass.ts` classifies as `model-rejected` — no retry, the
fallback chain advances with a warning. So confirm support before adding the
row.

| Core | How to check | In the repo |
| --- | --- | --- |
| `claude` | The Claude CLI has no model-list command, so `discoverClaudeModels()` is a deliberate `unsupported` stub. Take the id from Anthropic's model docs or release notes. | `src/agent/modelDiscovery.ts` |
| `codex` | `codex app-server --stdio`, then JSON-RPC `initialize` → `model/list`. Rows marked unavailable are skipped. | `discoverCodexModels` |
| `antigravity` | `agy models`. The CLI prints labels; ids are normalized (lowercase, non-alphanumerics → `-`), so the catalog id must be what `agy --model` accepts. | `discoverAntigravityModels` / `parseAntigravityModels` |
| `opencode` | `opencode models` — one `provider/model` id per line, account dependent. | `discoverOpencodeModels` |

Effort is a separate question from the id: `effortCapabilities` in
`src/agent/effort.ts` says which cores can express effort at all (opencode's
interactive TUI has no effort flag), and `customValues` is `false` for all
four, so every effort value must be advertised by the model entry itself.

## Steps

1. Get the exact id from the vendor — what the CLI accepts for `--model`, not
   the marketing name.
2. Confirm the core accepts it (table above).
3. Add `{ id, label, providers: ['<core>'], efforts?, tags? }` to
   `BUNDLED_CATALOG[<core>]` in `src/agent/modelCatalog.ts`, next to its
   family.
4. Add the same object to `model-catalog.json` under `providers.<core>` —
   same `id`, `label`, `efforts`, `tags`, no `providers` key, same position in
   the array.
5. Update the tests below if the model is a new flagship, adds an
   effort/tag shape nothing covers, or replaces a packaged default.
6. Run the tests.
7. Commit both files in the same commit.

## Tests

```bash
npx vitest run src/agent/modelCatalog.test.ts src/agent/modelCatalogLoader.test.ts
```

- `src/agent/modelCatalog.test.ts` — the sync pin, the per-provider
  assertions (claude/codex/antigravity non-empty, `opencode` exactly `[]`), and
  the flagship `efforts`/`tags` assertions. Add an assertion here when the new
  model introduces a shape nothing covers yet.
- `src/agent/modelCatalogLoader.test.ts` — tier resolution
  (cli/feed/cache/bundled) and diagnostics. A plain model addition does not
  change it; touch it only if loader behaviour changed.
- `src/agent/models.test.ts` and `src/agent/effort.test.ts` — only when
  resolution or effort-validation expectations change.

Then `npm run typecheck`: `BUNDLED_CATALOG` is typed `ModelCatalog`, so a
malformed entry is a compile error.

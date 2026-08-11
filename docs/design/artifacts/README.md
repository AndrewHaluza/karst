# Artifacts on the dashboard — design variants

Ticket: 869eetukv — `[FEAT] Add on the dashboard optional component to show artifacts for user`

Status: **design stage complete; implementation follows in its own ticket.**

This directory carries the design variants for an optional dashboard component
that surfaces durable artifacts for instant visibility — no session navigation,
no directory hunting. It extends the **finalized product spec** from the related
ticket, which is preserved verbatim under [`reference/`](reference/):

| File | What it is |
|---|---|
| `reference/karst-ticket-artifacts-implementation-spec.md` | The approved product/UX spec: semantic shelf → index → detail, in-webview navigation, count semantics, freshness, versions, multi-repo, a11y, loading/error, acceptance criteria. |
| `reference/karst-artifacts-finalized.html` | The approved reference prototype (dashboard shelf + index + detail, interactive). |
| `variant-a-origin-badges.html` | **Variant A — Origin badges.** Approved layout + one origin chip per artifact surface. |
| `variant-b-origin-shelves.html` | **Variant B — Origin shelves.** The shelf itself splits native vs karst; tinted card edges. |
| `variant-c-compact-ledger.html` | **Variant C — Compact ledger.** Dense rows with a dedicated origin column. |

All variants are standalone (no external assets — the real webview CSP forbids
them), emulate the VS Code palette in `:root` for dark/light, and render the
three surfaces (dashboard shelf, artifacts index, artifact detail) with working
navigation, `Esc` back behavior, and keyboard-focusable rows.

---

## 1. What this ticket adds to the finalized spec

The finalized spec defines the *semantic artifact model* (Plan, UAT report,
Review, PR summary) but says nothing about **who produced an artifact**. This
ticket's requirement is explicit: every artifact must display its **type/origin**
— native (produced directly by the agent core) vs Karst (non-native, specific
to an agent core) — for every supported core: Claude Code, Codex, Antigravity,
OpenCode.

So the shelf is **two-dimensional**: the finalized spec's *semantic* axis
(what the artifact is) plus this ticket's *origin* axis (who produced it).
All three variants keep the semantic axis intact and add the origin axis in
different visual weights.

## 2. Origin taxonomy

One closed vocabulary, one chip shape, on every artifact surface (shelf card,
index row, detail's Produced-by row):

```
ArtifactOrigin =
  | { kind: 'native', core: 'claude' | 'codex' | 'antigravity' | 'opencode' }
  | { kind: 'karst',  core: 'claude' | 'codex' | 'antigravity' | 'opencode' | null }
```

| Kind | Meaning | Chip | Example |
|---|---|---|---|
| **Native** | Produced **directly by the agent core** — a file the agent wrote, a screenshot it captured, its own report | core mark + core name + `Native` | `[C] Claude Code · Native` |
| **Karst · core** | Produced **by Karst**, attributed to the core's session (gate artifacts, findings, logs materialized for that session) | karst mark + `Karst · <core>` | `[K] Karst · Codex` |
| **Karst** (bare) | Produced by Karst, no core attribution (ticket-wide artifacts) | karst mark + `Karst` | `[K] Karst` |

The chip is **never icon-only** (UI-R28): the label is always text, the mark is
a secondary carrier. The label is the identity; the hue is decorative.

Core marks in the prototypes are **monogram placeholders** — the production
webview must render the canonical icons from `src/model/agentIdentity.ts`
(canonical icon + canonical name, UI-R10c), which the design-system injection
already makes available to every webview. Karst's own mark is the three-circle
brand mark (`media/karst.svg`).

### 2.1 Mapping to real karst data (illustrative)

| Artifact | Origin |
|---|---|
| Research notes / plan / summary the agent wrote into the worktree | `native:<core>` |
| Screenshots captured by the agent during its run | `native:<core>` |
| UAT gate artifact (`uat-ticket-<id>.log`, gate runs) | `karst:<core>` (the session that ran the gates) |
| Review findings / report | `karst:<core>` or `karst` |
| PR summary (ship) | `karst` |
| Session/process logs | `karst:<core>` |

The origin is **resolved at write time and stored**, never re-derived at read
time from the extension (same rule as attachment `kind` and gate `skipped`).

## 3. The variants

### Variant A — Origin badges

The approved reference layout, **byte-for-byte structure**: three semantic
preview cards, `View all N ›` to the index, stage-grouped index rows, semantic
detail. The origin dimension is one chip in each card's meta row, one chip on
each index row, and the Produced-by row in detail.

- **Strengths:** smallest delta from the approved design; the origin chip is
  visible at every glance level without competing with the semantic title;
  predictable.
- **Cost:** a chip in a small meta row is easy to overlook when scanning; the
  shelf does not "answer" the origin question until you look at each card.

### Variant B — Origin shelves

The shelf itself is organized along the origin axis: a **"From agents"** group
(native) and a **"From Karst"** group, each with its own count, plus a
segmented `All / Native / Karst` control. Cards carry a 2px top edge tinted by
origin (core hue for native, neutral for karst) so the axis reads at a glance.

- **Strengths:** origin is a first-class organizational axis — "what did the
  agent itself produce?" and "what did karst produce?" are answerable in one
  look; per-origin counts; the tint survives at small sizes.
- **Cost:** two headers cost vertical space on the dashboard; the segmented
  control brushes against the finalized spec's "no permanent filters" rule —
  it must ship as optional chrome with the two-group shelf as the resting
  state, and an absent group renders nothing (no empty placeholders).

### Variant C — Compact ledger

No preview cards. The shelf is a dense one-row-per-artifact ledger with a
**dedicated leading Origin column** — the most explicit form of the
requirement. Column header `Origin | Artifact | State`.

- **Strengths:** maximum density (5+ artifacts without scrolling); the origin
  column reads as a single vertical stack; no preview-ranking decisions to
  make or defend.
- **Cost:** loses the "3 most useful outputs" preview story of the finalized
  spec; rows are narrower, so the semantic title gets less room. Best used as
  the **index layout applied to the dashboard** when tickets accumulate many
  artifacts (the finalized spec's §10 defers search/filters until that point —
  this is the density answer, not a filter answer).

## 4. Comparison

| Criterion | A · Badges | B · Shelves | C · Ledger |
|---|---|---|---|
| Origin visible per artifact | chip on card/row | group + chip + tint | dedicated column |
| Fidelity to finalized prototype | highest | medium (shelf reorganized) | lowest (layout replaced) |
| Density (artifacts before scroll) | ~3 | ~4 | 5+ |
| Vertical cost on dashboard | lowest | highest | medium |
| Origin as a scanning axis | per-card | group-level | column-level |
| Risk | chip overlooked | filter-rule tension | preview story lost |
| Fits "many artifacts" tickets | no | yes | yes |

## 5. Recommendation

**Ship Variant A as the default** — it is the approved layout plus exactly the
origin dimension this ticket requires, so the follow-up implementation ticket
diffs against a known baseline rather than a redesign. **Adopt Variant C's
column as the index-row layout** (the index already is a list; giving every
index row a leading origin column costs nothing and satisfies "explicit
origin" at the index surface without touching the shelf). Variant B remains a
recorded alternative if product review wants origin to be the shelf's primary
axis.

## 6. Shared model (all variants)

From the finalized spec, unchanged and load-bearing:

- Shelf renders only when at least one artifact exists — **no empty state**.
- Count = top-level **semantic** artifacts; versions and raw files never
  inflate it.
- Preview selection uses semantic priority, not recency; 3 previews max.
- Navigation: `Ticket → Detail(origin=ticket)`, `Ticket → Index →
  Detail(origin=index)`, `Esc` mirrors Back, **no second webview/tab/drawer**.
- Detail is semantic-first, files last; `Open in editor ↗` is the explicit
  escape into VS Code's file model.
- Freshness: verification/review artifacts can read **stale**; staleness is
  never conflated with load failure.
- Loading: shelf absent (or local skeleton) until artifact metadata resolves;
  detail shows a local loading state; a failed load is "could not load", never
  a domain verdict.

## 7. Implementation notes for the follow-up ticket

Suggested event contract (naming per existing Karst conventions; see the
spec's §22):

```
artifact.list(ticketId)                       → ArtifactSummary[] (shelf + index)
artifact.get(artifactId)                      → ArtifactDetail (payload)
artifact.openResource(resourceUri)            → host opens the file
artifact.retry(artifactId)                    → re-attempt payload load
```

State shape (spec §23):

```ts
type ArtifactViewState =
  | { view: 'ticket' }
  | { view: 'index' }
  | { view: 'detail'; artifactId: string; origin: 'ticket' | 'index' };
// + per-view scroll positions (ticketScrollTop, indexScrollTop,
//   detailScrollTopByArtifactId)
```

Origin data model (this ticket's addition to the spec's §14 identity):

```ts
interface ArtifactOrigin {
  kind: 'native' | 'karst';
  core: AgentProvider | null;   // claude | codex | antigravity | opencode
}
```

- Origin is resolved once at write time and stored with the artifact identity.
- The webview renders origin via the existing `agentIdentity` injection
  (canonical core icons + labels); karst's mark is the three-circle brand SVG.
- The chip component is shared across shelf/index/detail in the webview —
  one CSS class set, one accessible-name pattern (`<core> native artifact` /
  `karst artifact for <core>`).
- Where artifacts live today: `globalStorage/artifacts/<ticketId>/` (gate
  artifacts), worktree files written by the agent (native), `gate_runs` /
  `review_findings` / `uat_findings` evidence rows (karst). The follow-up
  defines which of these become first-class semantic artifacts; this design
  only fixes how origin renders once they do.

## 8. Out of scope (per the finalized spec §21)

Search, persistent unread state, tags/favorites, pinning, user-configured
shelf order, separate artifact tabs, persistent side inspector, split-screen
comparison, drag-and-drop organization, arbitrary file browser, complex stage
filters, lifecycle-specific page redesign. None of the variants reintroduces
them.

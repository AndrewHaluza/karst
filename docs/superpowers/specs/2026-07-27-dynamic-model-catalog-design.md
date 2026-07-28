# Dynamic Model Catalog Design

**Ticket:** 869e9xdft

## Goal

Keep the Claude, Codex, and Antigravity model selectors current without an
extension release while preserving a usable offline catalog. Prefer the models
reported by the user's installed agent CLI because that list can reflect the
user's authentication, plan, rollout cohort, and local provider configuration.

## Decision

Karst will resolve each provider's catalog independently through this precedence
chain:

1. a valid, non-empty catalog discovered from the installed provider CLI;
2. that provider's valid, non-empty section in the Karst JSON feed;
3. the provider's last-known-good catalog cached by the extension;
4. the provider's bundled fallback catalog.

The Karst feed will be published from the repository's default branch at:

`https://raw.githubusercontent.com/AndrewHaluza/karst/main/model-catalog.json`

Updating that file changes the secondary catalog without publishing a new
extension. The bundled copy remains part of the extension so first use and
fully offline use always have choices for all three providers.

## Provider Discovery

Each provider implements the same host-agnostic loader interface and returns
model IDs plus display labels:

- **Codex:** start `codex app-server`, initialize its JSON-lines protocol, call
  `model/list`, collect the available models, and terminate the child cleanly.
- **Antigravity:** run `agy models` and parse its documented list output.
- **Claude:** use a non-interactive, machine-readable CLI discovery command only
  when the installed Claude version exposes one. Current Claude versions do not,
  so the loader reports discovery as unavailable and resolution proceeds to the
  Karst feed. Karst will not scrape the interactive `/model` terminal UI or
  require an Anthropic API key that may not match the user's Claude Code login.

CLI discovery is asynchronous, has a three-second timeout, captures at most 256
KiB of output, and kills timed-out children. Nothing on this path may block the
extension-host event loop.

Unsupported or missing CLI discovery is an ordinary unavailable result, not an
error shown to the user. Diagnostics distinguish unavailable commands,
timeouts, non-zero exits, protocol errors, and invalid output.

## Catalog Contract and Validation

The versioned feed has one independently validated section per provider:

```json
{
  "version": 1,
  "providers": {
    "claude": [
      { "id": "opus", "label": "Opus (latest)" }
    ],
    "codex": [
      { "id": "gpt-5.6-sol", "label": "GPT-5.6 Sol" }
    ],
    "antigravity": [
      {
        "id": "gemini-3.6-flash-high",
        "label": "Gemini 3.6 Flash (High)"
      }
    ]
  }
}
```

A model ID and label must be strings and non-blank after trimming. IDs must
match `[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}`. Labels may contain at most 160
characters and no control characters. Duplicate IDs are rejected within a
provider. Unknown top-level fields are ignored for forward compatibility, but
an unknown schema version is unusable.

An absent, malformed, or empty provider section fails only that provider's feed
tier. It does not discard valid sections for other providers. HTTP errors, a
three-second timeout, invalid JSON, responses larger than 256 KiB, and redirects
whose final URL is not HTTPS are unusable responses.

## Loading and Cache

Catalog loading begins during activation but does not delay the rest of
activation. The three provider CLI loaders run concurrently. The Karst feed is
fetched at most once per refresh and its validated sections are shared.

The initial UI may render the bundled catalog immediately. When resolution
finishes, open onboarding and Settings views receive an updated catalog state.
A manual window reload starts a fresh discovery. Karst does not poll in the
background in this feature.

Only a fully validated, non-empty resolved provider catalog is written to
`globalState`. Cache entries are separate per provider and include the catalog,
source, and timestamp. A corrupt cache entry is ignored. Cache age is recorded
for diagnostics but does not expire a still-usable list; the bundled fallback
remains the recovery path if cache validation fails.

## UI and Saved Selections

`src/agent/models.ts` remains the owner of bundled fallbacks and model
compatibility. The extension host becomes the single source for the current
resolved catalogs. Both onboarding and Settings receive provider-partitioned
model state; the hard-coded Settings HTML mirror is removed.

Existing launch precedence remains unchanged: a non-blank ticket model wins,
then the manifest default, then the agent CLI default. Catalog refresh never
rewrites stored selections.

If a ticket model or manifest default is not present in the current provider
catalog, its picker includes that exact value as a `Saved model` option. This
preserves selections during staged rollouts, temporary catalog regressions, and
custom model use. Switching providers still removes a known model belonging to
another provider, while unknown custom IDs retain the existing compatibility
behavior.

## Failure Isolation

Each provider resolves independently. A hung Codex app-server cannot delay
Antigravity or Claude beyond its own task, and a malformed Claude feed section
cannot invalidate a valid Antigravity section. Failure at every dynamic tier
selects that provider's bundled catalog without an error dialog.

Failures are logged with provider and tier but without credentials, environment
values, raw authentication output, or complete untrusted response bodies.

## Tests

Host-agnostic tests will prove:

- Codex protocol responses and Antigravity command output produce normalized
  catalogs;
- missing commands, non-zero exits, timeouts, malformed output, empty output,
  and oversized output proceed to the next tier;
- Claude proceeds to the feed when no supported CLI discovery exists;
- valid feed sections are accepted independently;
- HTTP failure, timeout, invalid JSON, unsupported schema versions, malformed
  sections, duplicate IDs, and empty sections fall through safely;
- precedence is CLI, feed, cache, then bundled;
- one provider's failure does not affect another provider's result;
- only valid non-empty catalogs enter the cache;
- onboarding and Settings consume host-supplied dynamic catalogs;
- saved ticket and default models remain selectable when absent from a refreshed
  catalog; and
- provider-switch compatibility and launch precedence remain unchanged.

Focused tests will be followed by typecheck, the complete Vitest suite, and the
production build.

## Out of Scope

- Adding or managing provider API keys.
- Scraping interactive terminal UIs.
- Guaranteeing that every listed model can be used after an entitlement changes
  between discovery and launch.
- Background polling or push updates while the editor remains open.
- Changing model IDs stored in existing tickets or manifests.

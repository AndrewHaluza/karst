# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Report it privately through GitHub:

1. Go to the [Security tab](../../security/advisories/new) of this repository
2. Click **Report a vulnerability**
3. Describe the issue, the impact, and how to reproduce it

This opens a private advisory visible only to you and the maintainer. GitHub
handles the disclosure workflow, including a private fork for developing the
fix and coordinated publication once it ships.

If GitHub private reporting is unavailable to you, open a regular issue
containing **only** the words "security report, please make contact" and no
technical detail, and you will be contacted to arrange a private channel.

## What to expect

- **Acknowledgement:** within 7 days
- **Assessment:** within 30 days, with a severity judgement and a rough fix timeline
- **Credit:** you will be credited in the advisory unless you ask otherwise

Karst is maintained by one person, so response is best-effort rather than
contractual. Please allow reasonable time for a fix before disclosing publicly.

## Scope

Karst runs locally in a VS Code extension host, spawns agent CLIs, executes
gate commands, and manages git worktrees. Reports are particularly welcome for:

- **Command injection** through manifest values, ticket fields, branch or
  worktree names, or gate definitions — anything user-controlled that reaches
  a spawned process
- **Secret leakage** — tokens, keys, or prompt content escaping into logs,
  diagnostic reports, gate evidence, or telemetry, bypassing the redaction
  pipeline in `src/logging/`
- **Path traversal** in worktree, approach-package, or artifact handling
- **Approach package installation** — the structure-preserving fetch,
  classification, entrypoint guards, or frontmatter sanitization for untrusted
  sources
- **Webview issues** — XSS or unsafe message passing across the extension
  host boundary
- **SQL injection** in store queries

Out of scope: vulnerabilities in agent CLIs themselves (report those upstream),
and anything requiring an attacker who already has local code execution as the
user running VS Code.

## Supported versions

The latest released version is supported. Fixes are not backported.

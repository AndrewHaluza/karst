# Karst documentation

Two kinds of document live here, and they are not interchangeable.

**Binding reference** describes how Karst works now. It is maintained, and a
pull request that contradicts it is wrong until the document is changed in the
same pull request.

**Working notes** are dated. They record what was decided, and why, at a point
in time. They are a historical record — read them for reasoning, never for
current behaviour. Where a note and the code disagree, the code is right.

## Binding reference

| Directory | What it holds |
|---|---|
| [`arch/`](arch/) | Architecture invariants. Read the one covering what you are touching **before** you change it — [`CONTRIBUTING.md`](../CONTRIBUTING.md#3-architecture-invariants) maps areas to files. |
| [`ui/`](ui/) | `UI-RULES.md` (numbered, pass/fail), the design system, the style guide, the rendered catalog, and the known conformance gaps. Binding for any webview change. |
| [`agent-cores/`](agent-cores/) | The hook contract and the cross-core parity table. |
| [`guides/`](guides/) | How-to: adding an agent core, resuming an investigation session. |
| [`troubleshooting/`](troubleshooting/) | Symptom-first runbooks. |
| [`glossary.md`](glossary.md) | Terms of art — ticket, stage, gate, verdict, worktree, approach. |

## Working notes

| Directory | What it holds |
|---|---|
| `plans/`, `superpowers/plans/` | Implementation plans, dated. Some were executed, some superseded, some abandoned. |
| `superpowers/specs/` | Design specs written before implementation. |
| `design/` | UI explorations, mockups and prototypes, including throwaway HTML. |
| `reviews/` | Point-in-time code and feature reviews, pinned to a commit. Findings may since have been fixed. |
| `issues/` | Written-up investigations of specific defects. |
| `handoffs/` | Session handoff notes. |

Working notes may reference absolute paths from the machine they were written
on, module names that have since been renamed, and schema versions that have
since moved. That is expected of a dated record, and is not a defect to fix.

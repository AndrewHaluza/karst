# [FIX] legacy Now text on the dashboard

Ticket: `869e883ry`

On the agent dashboard, each pipeline stage (Ship and all other stages) must present its work through a single, consistent "Inside" block that lists the concrete processes belonging to that stage — both the processes currently running and the ones that could run within it. Today the dashboard is inconsistent and shows legacy content: some stages render free-form/legacy "Now" text instead of processes, and stages that have a known, predefined set of steps do not surface those steps at all.

For example, the Ship stage is defined to commit, push, and open one PR per hot repo with an agent-written description, yet before it runs it only shows placeholder prose ("…has not run yet", "Commits, pushes, and opens one PR…") and while running it collapses to bare status text ("Writing PR description…", then "Done") — with no structured Inside block enumerating its processes.

Goal: replace the legacy per-stage text with one uniform Inside-block treatment across every stage. Each stage's Inside block should enumerate that stage's processes and reflect their live state, so that a stage which has not started still displays its predefined processes (in a pending state), and a running/completed stage shows each process with its outcome. The Ship stage, after its processes complete, should show its actual results in this same structured form (e.g. a PR process and a merge process, each with target repo and status such as PR number or 'clean') rather than transient one-line status text.

## Requirements

- All stages use the same Inside-block component/pattern; no stage renders legacy 'Now'/free-form text in place of processes.
- Stages with predefined processes show those processes even before they run (pending/not-yet-run state), instead of placeholder prose.
- Each process displays its current state and, when finished, its outcome/result details.
- The Ship stage in particular surfaces its predefined processes (commit/push/PR-per-repo, merge) and their results in the Inside block, replacing the 'Writing PR description… → Done' text flow.
- Rendering stays correct across the process lifecycle: not-started, in-progress, and completed.

## Acceptance criteria

- No stage renders legacy free-form "Now" text; every stage renders through the shared Inside-block component.
- A stage with predefined processes (e.g. Ship) shows those processes in a pending state before it has run.
- A running stage shows per-process live state; a completed stage shows per-process outcome (e.g. PR number, merge cleanliness).
- Ship specifically: commit/push/PR-per-repo and merge each appear as discrete processes with target repo and result, both pending and completed.
- No regression to other stages' existing process rendering (e.g. implement, uat) that already use the Inside block correctly.

<!-- AGENT INSTRUCTIONS:
This file uses an agent-optimized block format. DO NOT read this file entirely.
1. TABLE OF CONTENTS: Run this to list all available keys:
   grep -F "## [@" docs/issues/2026-11-26-opencode2-tui-prompt-size.md

2. EXTRACT A RULE: Run this to read a specific block (Example for ID 'issue:TUI-PROMPT-01'):
   awk "/^## \[@issue:TUI-PROMPT-01\]/,/END_DOC_BLOCK: \[@issue:TUI-PROMPT-01\]/" docs/issues/2026-11-26-opencode2-tui-prompt-size.md
-->
# opencode2 TUI `--prompt` size: measurement (2026-11-26, T1385)

This record holds the Part A measurement of T1385. It is a snapshot, not a current rule.

## [@issue:TUI-PROMPT-01] A 40 KB `--prompt` submits by itself, so the 24 KiB TUI limit is not applied

**Hypothesis.** T1371 and T1372 hung with the largest node prompts of the night (about 35 KB and 41 KB). The hypothesis was that the opencode2 TUI does not submit a `--prompt` above some size between 31 KB and 35 KB.

**Method.** Binary `~/.opencode/bin/opencode` (the configured `karst.opencode2.binaryPath`), version 2.2.7. Each run used a new empty scratch folder and the command `opencode --standalone --prompt <text>`. A Python `pty` driver gave the TUI a 200x50 terminal, answered its terminal queries (cursor position, device attributes, colors, window size), and sent no key. The prompt was `Reply only with OK.` plus ASCII filler, cut to the exact byte size. Each run lasted 75 s.

**Detection.** A submit shows in the TUI output as the `esc interrupt` spinner, the model answer as the `tok/s` status line, and the prompt size as the `Context` token count. A control run with a 19-byte prompt had `Context 20,311 tokens` and the answer `OK`.

| Prompt bytes | Submitted with no key | Model answered | Context tokens |
|---|---|---|---|
| 20,480 | yes | yes | 23,241 |
| 40,960 | yes | yes | 26,217 |

The token count grows with the prompt size, so the full prompt reached the model in both runs. The opencode2 log of both runs has no `ERROR` line.

**Result.** The size hypothesis is not confirmed for opencode 2.2.7. No `maxBytes` TUI limit is added, and the kickoff spill threshold stays at `KICKOFF_ARGV_MAX_BYTES` (100 KiB). The first-activity watchdog (`arch:GRAPH-FIRST-ACTIVITY`) still catches a node whose prompt does not start a session, for any cause.

**Limits.** The measurement used the user's default opencode home, not the karst launch environment (`OPENCODE_CONFIG_CONTENT`, the isolated XDG home, the hook plugin). The opencode2 log shows version 2.2.7 for the launches near 00:56 CET on 2026-11-26 (the night of T1371 and T1372), so the measured version is the same.

END_DOC_BLOCK: [@issue:TUI-PROMPT-01]

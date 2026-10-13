# Experiment 3 — interactive Codex (MANUAL, user-run, real TTY)

Provenance: the user ran the checklist in a real terminal against `karst-spike-codex` and reported
"pass" as ONE overall result. No per-item (a-f) breakdown or timings were given. Items below are
therefore recorded as "covered by the overall PASS", not individually witnessed.

Pre-condition (agent-observed): the first sandbox started logged-out (`warning: no OpenAI credentials
available`). `sbx secret set openai --oauth` (user-run, global) was required BEFORE `sbx create`;
the sandbox was then recreated and the warning did not recur.

| item | result | source |
|---|---|---|
| a. subscription (ChatGPT) OAuth, no API key | PASS (overall) | user; sandbox env `SBX_CRED_OPENAI_MODE=oauth` (agent-observed) |
| b. streamed output | PASS (overall) | user |
| c. resize | PASS (overall) | user |
| d. Ctrl-C interrupt, session survives | PASS (overall) | user |
| e. exit + reattach | PASS (overall) | user |
| f. kill + resume | PASS (overall) | user; agent saw `codex resume --last` in the process list afterwards |
| g. final argv | PARTIAL | agent saw `node .../bin/codex resume --last` and the vendored `codex resume --last`; the user did not paste the line. No `--dangerously-bypass...` flag was visible in that argv. |

Agent-observed after the manual run (`logs/11-codex-boundary.log`): `~/.codex/auth.json` is 40 bytes
(contents deliberately not read; a real OAuth token blob would be far larger, so it is most likely a
proxy placeholder, not proven).

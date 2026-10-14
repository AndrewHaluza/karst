# Experiment 2 — interactive Claude (MANUAL, user-run, real TTY)
a. subscription OAuth login: PASS
b. streamed output: PASS
c. resize: PASS
d. Ctrl-C interrupt, session survives: PASS
e. exit + reattach (`sbx run --name karst-spike-claude`): PASS
f. kill claude (`sbx exec ... pkill claude`) + `sbx run ... -- --continue`: conversation resumed: PASS
g. final argv inside sandbox: `claude --dangerously-skip-permissions --continue`
   - sbx adds --dangerously-skip-permissions itself (autonomy bound to the sandbox)
   - agent args after `--` are appended and accepted (open question 4: yes for --continue)
Timings: not captured (user did not report); create=103s first time (image pull).

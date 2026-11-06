# Form planner bench

- pass: plan; provider claude; judge `claude-sonnet-5-5` via claude (effort high); started 2026-11-06T00:03:18.295Z
- Ground truth is the gold fix patch and the F2P tests, hidden from the planner. The judge is blind to the model and scores the union of the drafts.
- Excluded and counted, never scored 0: judge-errors, runs with no draft, timeouts and call errors.

## By model

| model | runs | scored | judge errors | no draft | timeouts | errors | notDone | unrequested | f2p coverage | static defect rate | planner tokens (reported) | judge tokens (reported) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| claude-opus-5-5 | 3 | 3 | 0 | 0 | 0 | 0 | 0.67 | 0.00 | 75% | 0% | 713904 | 112913 |

## Per case

| case | model | status | drafts | notDone | unrequested | f2p | static defects |
|---|---|---|---|---|---|---|---|
| vuejs/core:pr-8785 | claude-opus-5-5 | ok | 1 | Add the PROPS binding check inside `resolveSetupReference`, so it returns `unref(__props["name"])` in inline mode and `unref($props["name"])` in non-inline mode. The drafts reject this change on purpose. They only patch the dotted-tag branch.<br>Wrap the props access in the `unref` helper (`context.helperString(UNREF)`) and use bracket-string access (`__props["info"]`, `$props["info"]`). The drafts generate plain `$props.info.icon` and `__props.info.icon` with no `unref`, so the generated tag string differs from the one the tests expect. | 0 | partial, partial | none |
| mui/material-ui:pr-23778 | claude-opus-5-5 | ok | 1 | 0 | 0 | covered | none |
| mui/material-ui:pr-24010 | claude-opus-5-5 | ok | 1 | 0 | 0 | covered | none |

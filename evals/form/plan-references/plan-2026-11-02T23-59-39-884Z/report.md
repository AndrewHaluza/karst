# Form planner bench

- pass: plan; provider claude; judge `claude-opus-5-5` via claude (effort low); started 2026-11-02T23:59:39.884Z
- Ground truth is the gold fix patch and the F2P tests, hidden from the planner. The judge is blind to the model and scores the union of the drafts.
- Excluded and counted, never scored 0: judge-errors, runs with no draft, timeouts and call errors.

## By model

| model | runs | scored | judge errors | no draft | timeouts | errors | notDone | unrequested | f2p coverage | static defect rate | planner tokens (reported) | judge tokens (reported) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| claude-sonnet-5-5 | 6 | 6 | 0 | 0 | 0 | 0 | 1.17 | 0.33 | 69% | 0% | 2435977 | 218049 |

## Per case

| case | model | status | drafts | notDone | unrequested | f2p | static defects |
|---|---|---|---|---|---|---|---|
| vuejs/core:pr-8470 | claude-sonnet-5-5 | ok | 1 | 0 | 0 | covered | none |
| vuejs/core:pr-8785 | claude-sonnet-5-5 | ok | 1 | Add a PROPS binding check to resolveSetupReference itself. The gold change applies to all callers, not only the dotted-tag branch.<br>Wrap the props access in the unref helper. The gold output is `_unref(__props["info"])` inline and `_unref($props["info"])` non-inline. The drafts explicitly say not to add unref.<br>Use JSON.stringify bracket access (`__props["info"]` / `$props["info"]`), as the gold does. The drafts specify genPropsAccessExp dot access (`__props.info` / `$props.info`), so the generated tag string differs from the expected output. | Handle the PROPS_ALIASED binding type with __propsAliases lookup | partial, partial | none |
| vuejs/core:pr-9213 | claude-sonnet-5-5 | ok | 1 | Gold adds an `isSlotFallback` flag on the VNode interface (vnode.ts) and sets it in renderSlot. The drafts use a key suffix (`_fb`) instead, so no flag is added.<br>Gold changes processFragment in renderer.ts to unmount the old Fragment when its slot-fallback state differs from the new one. The drafts explicitly reject any renderer change and depend on a key change to force a remount. | Append a `_fb` suffix to the slot Fragment key when the fallback renders | partial, covered | none |
| mui/material-ui:pr-23778 | claude-sonnet-5-5 | ok | 1 | 0 | 0 | covered | none |
| mui/material-ui:pr-24010 | claude-sonnet-5-5 | ok | 1 | 0 | 0 | covered | none |
| mui/material-ui:pr-23806 | claude-sonnet-5-5 | ok | 1 | Replace React.useEffect with useEnhancedEffect (layout effect on the client) in packages/material-ui/src/useMediaQuery/useMediaQuery.js, so the resolved match applies before paint. The draft explicitly forbids any change to useMediaQuery.js.<br>Add a new 'Client-side only rendering' section to use-media-query.md with a per-call noSsr example. The draft gives only the theme example and edits the options.noSsr entry. | 0 | none | none |

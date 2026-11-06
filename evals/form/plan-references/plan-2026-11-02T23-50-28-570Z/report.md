# Form planner bench

- pass: plan; provider claude; judge `claude-opus-5-5` via claude (effort low); started 2026-11-02T23:50:28.570Z
- Ground truth is the gold fix patch and the F2P tests, hidden from the planner. The judge is blind to the model and scores the union of the drafts.
- Excluded and counted, never scored 0: judge-errors, runs with no draft, timeouts and call errors.

## By model

| model | runs | scored | judge errors | no draft | timeouts | errors | notDone | unrequested | f2p coverage | static defect rate | planner tokens (reported) | judge tokens (reported) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| claude-sonnet-5-5 | 6 | 6 | 0 | 0 | 0 | 0 | 1.00 | 0.00 | 69% | 17% | 2286543 | 218324 |

## Per case

| case | model | status | drafts | notDone | unrequested | f2p | static defects |
|---|---|---|---|---|---|---|---|
| vuejs/core:pr-8470 | claude-sonnet-5-5 | ok | 1 | 0 | 0 | covered | none |
| vuejs/core:pr-8785 | claude-sonnet-5-5 | ok | 2 | Wrap the props access in the unref helper (context.helperString(UNREF)), so the output is `_unref(__props["Foo"]).Bar` or `_unref($props["Foo"]).Bar`. The drafts do not ask for the unref wrapper. Draft 2 also asks for the dotted genPropsAccessExp form (`__props.Foo`) instead of the bracket JSON.stringify form, so the generated string will not match the expected test output. | 0 | partial, partial | none |
| vuejs/core:pr-9213 | claude-sonnet-5-5 | ok | 1 | The gold adds an internal `isSlotFallback` flag to the VNode interface in packages/runtime-core/src/vnode.ts. It sets `rendered.isSlotFallback = !validSlotContent` in renderSlot. The drafts use a different Fragment key suffix (`_fb`) instead of this flag.<br>The gold changes processFragment in packages/runtime-core/src/renderer.ts. When the old and new Fragments differ in `isSlotFallback`, it unmounts the old Fragment and mounts the new one. The drafts explicitly reject any change to the renderer and depend on the key mismatch to force the remount. | 0 | partial, covered | invented-path: docs/arch |
| mui/material-ui:pr-23778 | claude-sonnet-5-5 | ok | 1 | 0 | 0 | covered | none |
| mui/material-ui:pr-24010 | claude-sonnet-5-5 | ok | 1 | 0 | 0 | covered | none |
| mui/material-ui:pr-23806 | claude-sonnet-5-5 | ok | 1 | Change React.useEffect to useEnhancedEffect (layout effect on the client) in packages/material-ui/src/useMediaQuery/useMediaQuery.js. This lets the value resolve before paint, and the F2P ssr ponyfill test needs this change. The drafts explicitly forbid any change to the hook.<br>Add a new 'Client-side only rendering' section to use-media-query.md. The section shows the per-call noSsr option and the global theme override.<br>Use the theme API that the gold uses: createMuiTheme({ components: { MuiUseMediaQuery: { defaultProps: { noSsr: true } } } }). The drafts use the older props: { MuiUseMediaQuery: ... } shape. | 0 | none | none |

Region-order expectations (layout check g, `ui:LAYOUT-SANITY`).

One `<section>.json` per Settings section, keyed by tier (`wide` / `mid` / `narrow`, widths in
`src/ui/layout/layoutBreakpoints.ts`):

```json
{ "wide": { "layout": "side-by-side", "order": ["list", "detail"] },
  "narrow": { "layout": "stacked", "order": ["list", "detail"] } }
```

`order` lists `data-region` names top-to-bottom (stacked) or left-to-right (side-by-side). A route
with no file is reported "unchecked", never "passed". No `data-region` landmark exists in the
code yet; the Agents page ticket adds the first ones with its file.

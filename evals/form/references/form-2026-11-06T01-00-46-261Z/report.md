# Form intent eval

- pass: intent; provider claude; model `claude-haiku-5-5`; judge `claude-sonnet-5-5`; runs 3; started 2026-11-06T01:00:46.261Z
- F2P coverage: covered=1, partial=0.5; only tests whose behaviour the ISSUE states count (`not-in-issue` leaves the denominator). Spread = sd over runs.
- judge-errors are counted and excluded, never 0; `pending` = not reported. Function/API identifiers are info only, not a violation. Leaks should be 0 (proves the guard).

## Per source mode

| source | calls | call errors | F2P coverage | sd | missing | not-in-issue | unsupported/charter | parse first/nudged/degraded | scenarios | non-GWT | charters w/ paths | leaks | judge errors | tokens/call | s/call |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| raw | 18 | 0 | 50.0% | 0.14 | 7 | 0 | 0.39 | 18/0/0 | 3.1 | 0 | 3 | 0 | 0 | pending | 19.3 |
| improved:builtin | 18 | 0 | 38.9% | 0.02 | 15 | 0 | 0.17 | 18/0/0 | 2.7 | 0 | 3 | 0 | 0 | pending | 34.1 |

## Per instance (run 1; all runs in results.json)

### vuejs/core:pr-8470: Vue 3.3.4. defineEmits doesn't setup extended events

**Issue (truncated)**

```text
Vue 3.3.4. defineEmits doesn't setup extended events

### Vue version

3.3.4

### Link to minimal reproduction

https://github.com/tragid/vue-default-export-error/tree/vue-3.3.4-emit-errors

### Steps to reproduce

1. Create BaseEmits type:
```
export interface BaseEmits {
  (e: 'input-event', value: string): void;
  (e: 'change-event', value: string): void;
}
```
2. Create component and defineEmits with extending BaseEmits
interface ComponentEmits extends BaseEmits {
  (e: 'blur-event', value: string): void;
  (e: 'focus-event', value: string): void;
}

const emit = defineEmits<C…
```

| source | charter | per-test coverage | unsupported |
|---|---|---|---|
| raw | ## Goal<br>A developer declares a component's emitted events by extending a base emit type. When the component emits an inherited event in a development build, the browser console shows a warning that the event is not declared. The expected outcome is that this warning does not appear. The ticket does not state the expected production behavior. It also does not state whether parent components must receive the inherited events.<br><br>## Scenarios<br>- Given a development build with an inherited `input-event`, when the component emits `input-event`, then the console shows no warning about `input-event`.<br>- Given a development build with an inherited `change-event`, when the component emits `change-event`, then the console shows no warning about `change-event`. | w/ type (interface w/ extends): **partial** (s1) — The issue says defineEmits should support extended events, so inherited and own events should all be set up as declared emits. The scenarios only check that no dev warning appears when an inherited event is emitted. They never state that the component's declared emits include both the inherited events and the component's own events. The charter also says production behavior is unstated, but the issue complains that extended emits are not set up in production. | none |
| improved:builtin | ## Goal<br>A component declares its events with `defineEmits`. The events come from an interface that extends a base interface. The ticket expects `defineEmits` to support these extended events. In DEV, the console shows a warning for `input-event` and for `change-event`. The ticket does not describe the PROD result, so this charter has no PROD scenario. The ticket also does not state whether a parent listener for a base event receives the emitted value.<br><br>## Scenarios<br>- Given a component whose events extend a base interface, when the component emits `input-event` in DEV, then the console shows no warning for `input-event`.<br>- Given a component whose events extend a base interface, when the component emits `change-event` in DEV, then the console shows no warning for `change-event`. | w/ type (interface w/ extends): **covered** (s1) — The ISSUE expects defineEmits to support events inherited from an extended interface. Scenarios 1 and 2 check that base events such as input-event and change-event are treated as declared, with no warning. The test checks the compiled emits option at the compile level, but it checks the same behaviour. | none |

### vuejs/core:pr-8785: Can not use props.xxx type render component

**Issue (truncated)**

```text
Can not use props.xxx type render component

### Vue version

3.3.4

### Link to minimal reproduction

https://play.vuejs.org/#eNqNVE1v2zAM/SucL0kBfxy6k5EG3YYetsNabDn64thMotSWBIlOUxj+76Pk2PHctRgQBBb1SD4+6akNvmgdnxoM0mBlCyM0gUVq9DqTotbKELRgcBdCiTsh8ZvioERJIRygg51RNSw4fTHCHeISjxO3cNV5O5OFkpZgg5bGKnA3r7tsMwncUZZoYHkDfukC1BgJh+WiFKdFCG0XwuKAVaUWNw7RZbLjj1XSz8DseUFY6yon5BXAyhNLhdypuyxoQTCddMamywJIGL1KxtQgDPrBojrX8dEqyUp5Utllw2ZBOtDMAh7WrbPgQKRtmiRFKTmtxEqcTCyREqnr5J5hiWkkiRqjUtX3t/Ft/DkphaVpOEZbR1ujXiwaLpIF4aRNwsETmqjXCs3/tp2lTVvPtt60H5RmUciyfjuxn0lSsJaiQvOoSfBx/yVNzqf18sPHyDQ4zlIcsHj+R/xoz/1…
```

| source | charter | per-test coverage | unsupported |
|---|---|---|---|
| raw | ## Goal<br>A user who opens the minimal reproduction page expects the component to render as `<div>hello</div>`. The ticket reports that the component instead renders as `<info.icon></info.icon>`. The ticket does not state the value of `props.xxx`. The ticket does not include the content of the linked playground, so the component code is unknown. The ticket does not name the output channel for the render result, such as an HTML string or the DOM.<br><br>## Scenarios<br>- Given the minimal reproduction page runs on Vue 3.3.4, when the component renders, then the output is `<div>hello</div>`.<br>- Given the minimal reproduction page runs on Vue 3.3.4, when the component renders, then the output is not `<info.icon></info.icon>`.<br>- Given a component whose render tag is taken from a prop, when the component renders, then the output is `<div>hello</div>`. | resolve namespaced component from props bindings (non-inline): **partial** (s3) — The issue says a component taken from a prop (`info.icon`) should render as a component, not as a literal tag. Scenario 3 touches this. It does not state the dotted (namespaced) tag form or that the tag must resolve through the props binding. The exact compiled output `_unref($props["Foo"]).Example` and the non-inline mode are implementation details the issue does not state.<br>resolve namespaced component from props bindings (inline): **partial** (s3) — The issue says a component taken from a prop (`info.icon`) should render as a component, not as a literal tag. Scenario 3 touches this. It does not state the dotted (namespaced) tag form or that the tag must resolve through the props binding. The exact compiled output `_unref(__props["Foo"]).Example` and the inline mode are implementation details the issue does not state. | s3: The issue does not say that every component with a prop-based tag renders `<div>hello</div>`. That output belongs only to the specific reproduction, so this scenario invents a general criterion. |
| improved:builtin | ## Goal<br>When a component renders a tag name from a prop value, the user sees the rendered element. The ticket reports that the reproduction shows `<info.icon></info.icon>` where `<div>hello</div>` is expected. The ticket does not state the prop value, the component template, or other inputs. This charter covers only the reported case.<br><br>## Scenarios<br>- Given the minimal reproduction on Vue 3.3.4, when the user opens the demo, then the rendered output is `'<div>hello</div>'`.<br>- Given the minimal reproduction on Vue 3.3.4, when the user opens the demo, then the rendered output does not show `<info.icon></info.icon>`. | resolve namespaced component from props bindings (non-inline): **partial** (s1) — The ISSUE expects a namespaced component taken from a prop (info.icon) to render as the element, not as a literal tag. Scenario 1 states the rendered output of the demo. It does not name the namespaced prop component case. It does not state the compiler resolution that the test checks (the _unref($props[...]) tag in non-inline mode).<br>resolve namespaced component from props bindings (inline): **partial** (s1) — The ISSUE expects a namespaced component taken from a prop to render correctly. Scenario 1 states only the demo's rendered output. It does not name the namespaced prop component case. It does not state the inline-mode compiler resolution that the test checks (the _unref(__props[...]) tag). | none |

### mui/material-ui:pr-23778: [Select] When disabled the <input> element misses the disabled attribute

**Issue (truncated)**

```text
[Select] When disabled the <input> element misses the disabled attribute

<!-- Provide a general summary of the issue in the Title above -->

<!--
  Thank you very much for contributing to Material-UI by creating an issue! ❤️
  To avoid duplicate issues we ask you to check off the following list.
-->

<!-- Checked checkbox should look like this: [x] -->

- [x] The issue is present in the latest release.
- [x] I have searched the [issues](https://github.com/mui-org/material-ui/issues) of this repository and believe that this is not a duplicate.

## Current Behavior 😯

When you cr…
```

| source | charter | per-test coverage | unsupported |
|---|---|---|---|
| raw | ## Goal<br>A user sees a select field that is disabled. The input element in that field also has the disabled attribute. When the form is submitted, the value of the disabled field is not sent. Today the input element lacks the disabled attribute, and the disabled state appears only on the surrounding element.<br><br>## Scenarios<br>- Given a TextField with select and disabled, when the page renders, then the input element of that field has the disabled attribute in browser developer tools.<br>- Given a TextField with select and no disabled prop, when the page renders, then the input element of that field has no disabled attribute in browser developer tools.<br>- Given a form with a disabled TextField with select and a selected value, when the user submits the form, then the submitted form data does not include the value of that field.<br><br>## Not in scope<br>- Whether the aria-disabled attribute and the disabled CSS classes on the surrounding element remain. The ticket does not state this. | /home/material-ui/packages/material-ui/src/Select/Select.test.js:<Select /> accessibility sets disabled attribute in input when component is disabled: **covered** (s1) — The test checks that a disabled Select renders its input element with the disabled attribute. Scenario 1 states this: a TextField with select and disabled has an input element with the disabled attribute. | none |
| improved:builtin | ## Goal<br>When the select field is disabled, the input element has the disabled attribute. In the current release, the input element lacks this attribute, although the select field shows a disabled state. The ticket does not state whether aria-disabled must stay on the select field.<br><br>## Scenarios<br>- Given a disabled select field, when a user inspects the select field, then the input element has the disabled attribute.<br>- Given an enabled select field, when a user inspects the select field, then the input element does not have the disabled attribute.<br>- Given a disabled select field, when a user views the select field, then the select field shows a disabled state. | /home/material-ui/packages/material-ui/src/Select/Select.test.js:<Select /> accessibility sets disabled attribute in input when component is disabled: **covered** (s1) — Scenario 1 states that a disabled select field has an input element with the disabled attribute. This is the behaviour the ISSUE asks for and the test name checks. | none |

### mui/material-ui:pr-23786: [Switch] preventDefault is ignored

**Issue (truncated)**

```text
[Switch] preventDefault is ignored

<!-- Provide a general summary of the issue in the Title above -->

<!--
  Thank you very much for contributing to Material-UI by creating an issue! ❤️
  To avoid duplicate issues we ask you to check off the following list.
-->

<!-- Checked checkbox should look like this: [x] -->

- [x] The issue is present in the latest release.
- [x] I have searched the [issues](https://github.com/mui-org/material-ui/issues) of this repository and believe that this is not a duplicate.

## Current Behavior 😯

<!-- Describe what happens instead of the expecte…
```

| source | charter | per-test coverage | unsupported |
|---|---|---|---|
| raw | ## Goal<br>When a user clicks a Switch that has an `onClick` handler calling `preventDefault`, the Switch does not change its state. The Switch stays in the position it had before the click. The user sees no visual change to the Switch after the click. Before the fix, the Switch changes its state even when the handler calls `preventDefault`.<br><br>## Scenarios<br>- Given a Switch with an onClick handler that calls preventDefault, when the user clicks the Switch, then the Switch keeps its position.<br>- Given a Switch that is on, with an onClick handler that calls preventDefault, when the user clicks the Switch, then the Switch stays on.<br>- Given a Switch that is off, with an onClick handler that calls preventDefault, when the user clicks the Switch, then the Switch stays off. | /home/material-ui/packages/material-ui/src/internal/SwitchBase.test.js:<SwitchBase /> handleInputChange() should not change checkbox state when event is default prevented: **covered** (s1) — The ISSUE says that preventDefault in the onClick handler must stop the element from updating. Scenario 1, with scenarios 2 and 3, states that the Switch keeps its position after a click whose handler calls preventDefault. That is the behaviour the test checks. | none |
| improved:builtin | ## Goal<br>When a user clicks a Switch, and the onClick handler calls preventDefault on the event, the Switch must not change its position on screen. The ticket reports that the Switch still changes position. The ticket does not state whether the Switch is controlled or uncontrolled. It does not state the initial checked value. It names both "latest" and v4.11.0 for the Material-UI version.<br><br>## Scenarios<br>- Given a Switch in the off position with an onClick handler that calls preventDefault, when the user clicks the Switch, then the Switch stays in the off position.<br>- Given a Switch in the on position with an onClick handler that calls preventDefault, when the user clicks the Switch, then the Switch stays in the on position.<br>- Given a Switch with an onClick handler that calls preventDefault, when the user clicks the Switch, then the knob and track do not move to a new position. | /home/material-ui/packages/material-ui/src/internal/SwitchBase.test.js:<SwitchBase /> handleInputChange() should not change checkbox state when event is default prevented: **covered** (s1) — The issue says that calling preventDefault in onClick must stop the Switch from changing state. Scenarios 1 to 3 state that the Switch stays in its position after such a click. The hidden test checks this at the SwitchBase level. | none |

### darkreader/darkreader:pr-7241: [Bug] Base64 padding in themes breaks the extension

**Issue (truncated)**

```text
[Bug] Base64 padding in themes breaks the extension

<!--
  ⚠⚠ Do not delete this issue template! ⚠⚠
  Reported issues must use this template and have all the necessary information provided.
  Incomplete reports are likely to be ignored and closed.
-->

<!--
  Thank you for taking the time to create a report about a bug.
  Ensure that there are no other existing reports for this bug.
  Please check if the issue is resolved after a restart of the browser.
  Additionally, you should check if the issue persists in a new browser profile.
  Remember to fill out every section on this repo…
```

| source | charter | per-test coverage | unsupported |
|---|---|---|---|
| raw | ## Goal<br>A theme that contains a base64 image padded with `==` must not break the extension. Pages load normally, and the extension still works after the user disables and enables it. No error appears in the background inspect view. The ticket does not describe what the broken styling looks like on screen. The ticket also does not say when the `IGNORE INLINE STYLE` line is needed.<br><br>## Scenarios<br>- Given the extension is enabled and a theme contains the sample CSS with the `==` padded base64 string, when the user refreshes a tab for a site with DarkReader enabled, then the page shows no broken styling.<br>- Given the extension is enabled and the same theme is saved, when the user opens the background inspect view, then no "Uncaught (in promise) SyntaxError: Invalid regular expression" error is shown.<br>- Given the theme has a dummy entry with the padded base64 string and no open tab matches its URL, when the user refreshes a tab on an enabled site, then the dummy entry has no effect on that page.<br>- Given the same theme is active, when the user disables and enables the extension repeatedly, then the extension still applies its styling to enabled sites. | tests/generators/utils/parse.tests.ts:Base64 in CSS: **partial** (s1) — The ticket expects CSS with a `==` padded base64 string to be processed properly. The test checks that the parser keeps the CSS in one block and does not split it at the padding. Scenarios 1-3 check only the user-visible outcome: no broken styling, no error, and no effect from the dummy entry. None says the CSS block stays intact, and none says the padding is not treated as a block delimiter. No hunk was supplied for this entry, so this judgement uses the test name and the same-file hunk in Test 2.<br>tests/generators/utils/parse.tests.ts: **partial** (s1) — This hunk adds the 'Base64 in CSS' regression test. It checks that `getSitesFixesFor` returns the CSS with the base64 `==` padding intact, and that no `') !important;` fragment appears as a URL pattern. The ticket states that the padding must not break processing. The charter scenarios cover only the UI outcome and the absence of the error. None says the parser output stays correct for the padded CSS. | none |
| improved:builtin | ## Goal<br>A user can use the Dark Reader extension with a theme that has a base64 image padded with `==`. The page loads with the theme. The background inspect view shows no `Invalid regular expression` error. The extension still works after the user disables and enables it again. The ticket does not define the result for a site that matches a padded entry, or the effect of the IGNORE INLINE STYLE line.<br><br>## Scenarios<br>- Given the theme has a base64 image padded with `==`, when the user refreshes a tab, then the theme applies to the page.<br>- Given the theme has a base64 image padded with `==`, when the user opens the background inspect view, then no `Invalid regular expression` error appears.<br>- Given the extension is enabled, when the user disables and enables the extension several times, then the theme still applies to a refreshed tab.<br>- Given the theme has the dummy entry, when the user refreshes a tab, then the page shows no change from that entry. | tests/generators/utils/parse.tests.ts:Base64 in CSS: **partial** (s2) — The ISSUE says custom CSS with a base64 string padded with `==` must be processed properly, not split into bogus domain patterns. Scenario 2 checks only the downstream symptom, the missing `Invalid regular expression` error. No scenario states that the CSS block stays intact and that no `') !important;` pattern appears in the parsed result.<br>tests/generators/utils/parse.tests.ts: **partial** (s2) — This is the same hunk as the 'Base64 in CSS' regression test. The parser must not treat `==` padding inside CSS as a block delimiter. The charter covers only the observable symptoms (theme applies, no regex error). It does not cover the parse result: the CSS stays whole and the `==` is not a delimiter. | none |

### darkreader/darkreader:pr-6747: [Bug] Incorrect `*` checking

**Issue (truncated)**

```text
[Bug] Incorrect `*` checking

<!--
  ⚠⚠ Do not delete this issue template! ⚠⚠
  Reported issues must use this template and have all the necessary information provided.
  Incomplete reports are likely to be ignored and closed.
-->

<!--
  Thank you for taking the time to create a report about a bug.
  Ensure that there are no other existing reports for this bug.
  Please check if the issue is resolved after a restart of the browser.
  Additionally, you should check if the issue persists in a new browser profile.
  Remember to fill out every section on this report and remove any that …
```

| source | charter | per-test coverage | unsupported |
|---|---|---|---|
| raw | ## Goal<br>When a user opens the reported page with Dark Reader enabled, the site fix for that page must apply. The ticket reports that the site fix does not apply on this page. The ticket does not name the specific site fix. The ticket does not describe the visible change that a correct site fix causes. The ticket does not state which Dark Reader theme setting the user has. The ticket does not state whether other sites are affected.<br><br>## Scenarios<br>- Given Firefox Nightly 93.0a1 on Arch Linux with Dark Reader enabled, when the user opens https://unix.stackexchange.com/questions/405783/why-does-man-print-gimme-gimme-gimme-at-0030, then the site fix for that page is applied.<br>- Given Dark Reader enabled with issue #6738 fixed, when the user opens https://unix.stackexchange.com/questions/405783/why-does-man-print-gimme-gimme-gimme-at-0030, then the site fix for that page is applied.<br><br>## Not in scope<br>- Issue #6737, which this issue blocks.<br>- Issue #6738, except as the state in which this issue appears.<br>- The list of non-qualified domains and its contents. | tests/generators/utils/parse.tests.ts:Index config: **partial** (s2) — The issue implies the generic '*' fix should be first (fixes[0]). The scenarios only say the site fix applies. They do not state the ordering.<br>tests/generators/utils/parse.tests.ts:Domain appearing multiple times within the same record: **partial** (s2) — The test checks that the '*' fix comes first for a domain listed more than once in a record. The scenarios only state that a fix applies. They do not state the ordering.<br>tests/generators/utils/parse.tests.ts: **partial** (s2) — The hunk moves the '*' fix to the front of the results and adds a test for it. The issue implies this ordering through fixes[0].url[0] !== '*'. The scenarios do not state it.<br>tests/generators/utils/parse.tests.ts:The generic fix appears first: **partial** (s2) — The test checks that the generic '*' fix is first in the results. The issue implies this by saying the check should use fixes[0]. The scenarios only say the site fix applies, not that the generic fix is first.<br>tests/generators/utils/parse.tests.ts:Domain appearing in multiple records: **partial** (s2) — The test checks that the '*' fix comes before the other matching fixes. The issue implies this ordering. The scenarios do not state it. | none |
| improved:builtin | ## Goal<br>When a user opens the listed Unix Stack Exchange page with Dark Reader enabled, the site fixes are applied to the page. The ticket does not name the fixes, so the expected visible result is unknown. The ticket also does not name the non-qualified domains or describe what change #6738 makes. Those items are unknown, and the tester needs them to confirm the expected fixes.<br><br>## Scenarios<br>- Given Dark Reader is enabled with the Dynamic theme, when the user opens https://unix.stackexchange.com/questions/405783/why-does-man-print-gimme-gimme-gimme-at-0030, then the site fixes are applied.<br>- Given the change for #6738 is in place, when the user opens the same page, then the site fixes are applied. | tests/generators/utils/parse.tests.ts:Index config: **missing** — The test checks that the generic '*' fix is ordered first in the fixes array. The issue implies the '*' entry should be first (fixes[0].url[0]), but no scenario covers fix ordering or the '*' check.<br>tests/generators/utils/parse.tests.ts:Domain appearing multiple times within the same record: **missing** — The test checks that the generic '*' fix is first when a domain repeats in one record. The issue implies the '*' entry should be first, but no scenario covers ordering.<br>tests/generators/utils/parse.tests.ts: **missing** — The hunk moves the '*' generic fix to the first position and adds a test for it. The issue implies the '*' check should use fixes[0], but no scenario covers this ordering.<br>tests/generators/utils/parse.tests.ts:The generic fix appears first: **missing** — The test checks that the '*' fix is first in the result. The issue implies the check should use fixes[0].url[0] !== '*', but no scenario states this.<br>tests/generators/utils/parse.tests.ts:Domain appearing in multiple records: **missing** — The test checks that the generic '*' fix is first when a domain appears in multiple records. The issue implies the '*' entry should be first, but no scenario covers ordering. | s2: The issue does not say what change #6738 makes. The scenario assumes an unspecified change and invents a precondition. |

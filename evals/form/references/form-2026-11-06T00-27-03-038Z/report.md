# Form intent eval

- pass: intent; provider claude; model `claude-opus-5-5`; judge `claude-sonnet-5-5`; runs 1; started 2026-11-06T00:27:03.038Z
- F2P coverage: covered=1, partial=0.5; only tests whose behaviour the ISSUE states count (`not-in-issue` leaves the denominator). Spread = sd over runs.
- judge-errors are counted and excluded, never 0; `pending` = not reported. Function/API identifiers are info only, not a violation. Leaks should be 0 (proves the guard).

## Per source mode

| source | calls | call errors | F2P coverage | sd | missing | not-in-issue | unsupported/charter | parse first/nudged/degraded | scenarios | non-GWT | charters w/ paths | leaks | judge errors | tokens/call | s/call |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| raw | 6 | 0 | 60.0% | pending | 0 | 0 | 0.40 | 6/0/0 | 2.7 | 0 | 1 | 0 | 1 | pending | 8.3 |
| improved:builtin | 6 | 0 | 37.5% | pending | 5 | 0 | 0.17 | 6/0/0 | 2.7 | 0 | 1 | 0 | 0 | pending | 18.2 |

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
| raw | ## Goal<br>A component that declares its events with `defineEmits` and an interface that extends a base interface has both the base events and the events of the extended interface set up. When the component emits a base event, the developer does not see a Vue warning in development, and the event is set up in production.<br><br>## Scenarios<br>- Given a component that uses `defineEmits<ComponentEmits>()` and `ComponentEmits` extends `BaseEmits`, which declares `input-event`, when the component emits `input-event` in development, then the console does not show the warning `Component emitted event "input-event" but it is neither declared in the emits option nor as an "onInput-event" prop.`<br>- Given a component that uses `defineEmits<ComponentEmits>()` and `ComponentEmits` extends `BaseEmits`, which declares `change-event`, when the component emits `change-event` in development, then the console does not show the warning `Component emitted event "change-event" but it is neither declared in the emits option nor as an "onChange-event" prop.`<br>- Given a production build of a component that uses `defineEmits<ComponentEmits>()` and `ComponentEmits` extends `BaseEmits`, when the component emits `input-event` or `change-event`, then the two events are set up as declared events of the component.<br>- Given a component whose `ComponentEmits` interface declares `blur-event` and `focus-event` and extends `BaseEmits`, when the component emits `blur-event` or `focus-event` in development, then the console does not show a "neither declared in the emits option" warning for the event. | w/ type (interface w/ extends): **partial** (s3) — The test checks that the compiler output lists both the extended event and the base event in the `emits` option. Scenarios 1-4 state the behaviour at runtime: no warning in development, events set up in production. Scenario 3 comes closest because it says the base events are set up as declared events. No scenario states that the compiled `emits` option contains both the base and the extended events, so the key part is missing. | none |
| improved:builtin | ## Goal<br>A component that declares its events with `defineEmits<ComponentEmits>()`, where `ComponentEmits` extends another interface, has the extended events and the events of the interface as declared events. In development, an emit of an inherited event does not show the "neither declared in the emits option" warning. In production, the extended emits are set up. The ticket does not state the observable production symptom or the production check.<br><br>## Scenarios<br>- Given a component whose `ComponentEmits` interface extends `BaseEmits`, which declares `input-event` and `change-event`, when the component emits `input-event` in a development build, then the console does not show `Component emitted event "input-event" but it is neither declared in the emits option nor as an "onInput-event" prop.`<br>- Given the same component, when the component emits `change-event` in a development build, then the console does not show `Component emitted event "change-event" but it is neither declared in the emits option nor as an "onChange-event" prop.`<br>- Given the same component in a production build, when the component emits `input-event` or `change-event`, then the extended emits are set up. Unknown: the ticket does not name the result that a user can observe in a production build. | w/ type (interface w/ extends): **partial** (s3) — The issue states that defineEmits<ComponentEmits>() with an interface extending BaseEmits must set up the inherited events. The test checks that the compiled output has both 'bar' and 'foo' in emits. Scenarios 1 and 2 only check that the dev warning is absent. Scenario 3 says the extended emits are set up, but it names no concrete result. No scenario states that the compiled emits option includes the inherited events, so a key part is missing. | s3: The scenario expects an unnamed production result and invents a production-only check. The issue reports that the emits are not set up, and it does not separate production behaviour from development behaviour. |

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
| raw | ## Goal<br>A component that a template references as `props.xxx` renders correctly. In the reported case, the render output is `<div>hello</div>`, not `<info.icon></info.icon>`. The ticket does not state the template, the props, or the render mode, because the details are only in the linked reproduction. The ticket also does not state the relation between `props.xxx` in the title and `info.icon` in the output. The ticket names Vue version 3.3.4 as the reported version, but does not state the fixed version or other affected versions.<br><br>## Scenarios<br>- Given the linked minimal reproduction on a version that includes the fix, when a user renders the reproduction, then the render output is `<div>hello</div>`.<br>- Given the linked minimal reproduction on a version that includes the fix, when a user renders the reproduction, then the render output does not contain `<info.icon></info.icon>`. | judge-error: invalid JSON |  |
| improved:builtin | ## Goal<br>A component that a template renders through a `props.xxx` type reference, such as `info.icon`, shows its own output. The output does not contain a literal element with the name of the reference. The ticket gives `<div>hello</div>` as the expected render output and `<info.icon></info.icon>` as the actual render output on Vue 3.3.4. The ticket text does not state the exact template, the prop shape, or the render mode (browser or server). These details are only in the linked reproduction.<br><br>## Scenarios<br>- Given the linked reproduction on a version with the fix, when a user opens the reproduction and reads the render output, then the render output is `<div>hello</div>`.<br>- Given the linked reproduction on a version with the fix, when a user opens the reproduction and reads the render output, then the render output does not contain `<info.icon></info.icon>`. | resolve namespaced component from props bindings (non-inline): **partial** (s1) — The issue states that a `props.xxx` style component must render as a component, not as a literal element. Scenario 1 covers this only through the output of the linked reproduction. The test checks the non-inline compiled tag `_unref($props["Foo"]).Example` and that no component resolve helper is used. The issue does not state this compiler output, and the charter does not state the non-inline mode.<br>resolve namespaced component from props bindings (inline): **partial** (s1) — The issue states that a namespaced component taken from props must render as a component. Scenario 1 covers this only through the render output of the linked reproduction. The test checks the inline compiled tag `_unref(__props["Foo"]).Example` and that no component resolve helper is used. The issue does not state this compiler output, and the charter does not state the inline mode. | none |

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
| raw | ## Goal<br>When a developer renders a `<TextField select disabled />`, the `<input>` element of the field has the `disabled` attribute, as the `<input>` element of a regular disabled TextField does. A disabled select field thus does not submit its value with a form. The ticket does not state if the `aria-disabled="true"` attribute and the disabled classes on the div must stay, so this is unknown.<br><br>## Scenarios<br>- Given a page that shows a `<TextField select disabled />`, when the user inspects the select field in the browser DOM, then the `<input>` element has the `disabled` attribute.<br>- Given a form that contains a `<TextField select disabled />` with a value, when the user submits the form, then the submitted data does not contain the value of the disabled select field.<br>- Given a page that shows a disabled native select field, when the user inspects the field in the browser DOM, then the `<select>` element has the `disabled` attribute. | /home/material-ui/packages/material-ui/src/Select/Select.test.js:<Select /> accessibility sets disabled attribute in input when component is disabled: **covered** (s1) — The test checks that the input element has the disabled attribute when Select is disabled. Scenario 1 states that the `<input>` element of a disabled select field has the `disabled` attribute, which matches the ISSUE's expected behaviour. | s3: The ISSUE only mentions that the native select is disabled as a comparison, in a parenthetical remark. It does not state an expected outcome for a native select, so this scenario is invented. |
| improved:builtin | ## Goal<br>When a user renders `<TextField select disabled />`, the `<input>` element has the `disabled` attribute, as the `<input>` element of a regular disabled TextField does. A form submission does not include the value of the disabled select field. The ticket does not state if the `aria-disabled="true"` attribute and the classes on the div stay after the fix. The ticket also does not name the React version or the browser.<br><br>## Scenarios<br>- Given a page that renders `<TextField select disabled />`, when the user inspects the select field in the browser DOM, then the `<input>` element has the `disabled` attribute.<br>- Given a form that contains `<TextField select disabled />` with a value, when the user submits the form, then the submitted data does not include the value of the disabled select field.<br>- Given a page that renders a disabled native select TextField, when the user inspects the field in the browser DOM, then the `select` element has the `disabled` attribute. | /home/material-ui/packages/material-ui/src/Select/Select.test.js:<Select /> accessibility sets disabled attribute in input when component is disabled: **covered** (s1) — The ISSUE says the <input> of a disabled select TextField should have the disabled attribute. Scenario 1 states this: the <input> element has the `disabled` attribute. The test hunk is not available, so this rests on the test name. | none |

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
| raw | ## Goal<br>A Switch with an `onClick` handler that calls `preventDefault` does not change state when the user clicks it. The Switch UI stays in the state that it had before the click.<br><br>## Scenarios<br>- Given a Switch with an `onClick` handler that calls `event.preventDefault()`, when the user clicks the Switch, then the Switch UI does not update and the Switch stays in its previous state. | /home/material-ui/packages/material-ui/src/internal/SwitchBase.test.js:<SwitchBase /> handleInputChange() should not change checkbox state when event is default prevented: **covered** (s1) — The test checks that a default-prevented event does not change the checkbox state. Scenario 1 states that a Switch with an onClick handler that calls preventDefault does not change state when clicked. | none |
| improved:builtin | ## Goal<br>A Switch with an `onClick` handler that calls `event.preventDefault()` does not change its state when the user clicks the Switch. The Switch UI stays as it was before the click. The ticket reports the fault on Material-UI v4.11.0 with React v16.14.0.<br><br>## Scenarios<br>- Given a Switch with an `onClick` handler that calls `event.preventDefault()`, when the user clicks the Switch, then the Switch UI does not update and the Switch stays in the same state as before the click. | /home/material-ui/packages/material-ui/src/internal/SwitchBase.test.js:<SwitchBase /> handleInputChange() should not change checkbox state when event is default prevented: **covered** (s1) — The issue states that calling preventDefault in onClick should stop the Switch from updating. Scenario 1 states that the Switch stays in the same state after such a click. | none |

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
| raw | ## Goal<br>A theme that contains a base64 string padded with `==` does not break the extension. Dark Reader continues to function, and pages show correct CSS. The ticket states the expected result only for an entry with no matching open tab: the extension ignores that entry. The ticket does not state the expected result on a website that matches the entry. The ticket does not state if the fix must apply to other padding or other browsers. The report names Chrome and Opera.<br><br>## Scenarios<br>- Given the extension is enabled and a theme contains the ticket's `thisisnotarealwebsite.dummy` entry with the `==` padded base64 string, when the user refreshes a tab with a website that has Dark Reader enabled, then the website shows correct CSS with no breakage.<br>- Given the same entry is in a theme, when the user turns the extension off and on repeatedly, then the extension continues to function correctly on the open website.<br>- Given the same entry is in a theme and no open tab matches `thisisnotarealwebsite.dummy`, when the user refreshes an open tab, then the CSS in the entry has no effect on that tab.<br>- Given the same entry is in a theme and the 'background' inspect view is open, when the user refreshes a tab with a website that has Dark Reader enabled, then the view does not show `Uncaught (in promise) SyntaxError: Invalid regular expression`.<br>- Given a theme contains the same entry without the `IGNORE INLINE STYLE` line, when the user refreshes a tab with a website that has Dark Reader enabled, then the website shows correct CSS and the extension continues to function correctly. | tests/generators/utils/parse.tests.ts:Base64 in CSS: **partial** (s1) — The test checks that the parser splits blocks correctly and keeps the `==` padded base64 CSS inside one block. Scenario 1 states no breakage on refresh, but it does not state that the CSS stays intact, nor that the `=`-run delimiter is ignored inside the CSS.<br>tests/generators/utils/parse.tests.ts: **partial** (s1) — The test checks that the parser keeps the base64 `==` padding inside the CSS block and splits blocks only at real delimiters. Scenarios 1 and 5 state a correct, working result at user level, but none states the parsed block structure. | s3: The ticket says the entry is ignored when no open tab matches. Scenario 3 says the CSS has no effect on the tab, which restates that. This is supported, so it is not invented. |
| improved:builtin | ## Goal<br>A theme that contains a base64 string padded with `==` does not break the extension. The extension processes the custom CSS properly and continues to function. The ticket does not define what "broken CSS" and "function properly" look like on a page, so the tester must compare the page with the page before the theme change.<br><br>## Scenarios<br>- Given the extension is enabled and a theme contains the ticket's `thisisnotarealwebsite.dummy` entry with the `==`-padded base64 string and the `IGNORE INLINE STYLE` section, when the user refreshes a tab with a website that has Dark Reader enabled, then the page shows no broken CSS.<br>- Given the same theme entry and no open tab that matches `thisisnotarealwebsite.dummy`, when the user refreshes a tab with a website that has Dark Reader enabled, then the entry has no effect on that tab.<br>- Given the same theme entry is present, when the user turns the extension off and on repeatedly, then the extension continues to function properly.<br>- Given the same theme entry is present and the 'background' inspect view is open, when the user refreshes a tab with a website that has Dark Reader enabled, then the view does not show `SyntaxError: Invalid regular expression` with `Unmatched ')'`.<br>- Given the same theme entry without the `IGNORE INLINE STYLE` section, when the user refreshes a tab with a website that has Dark Reader enabled, then the page shows no broken CSS and the 'background' inspect view does not show the error. The ticket reports that this variant fails only sometimes and possibly depends on the browser, so the affected browsers are unknown.<br>- Given a theme entry for a website that is open in a tab, with custom CSS that contains a `==`-padded base64 image, when the user refreshes the tab, then the extension processes the custom CSS properly and continues to function. The ticket does not state the expected appearance of the page for this case. | tests/generators/utils/parse.tests.ts:Base64 in CSS: **partial** (s6) — The issue states that CSS with a '==' padded base64 string must be processed properly. Scenario 6 touches this, but only as 'processes the custom CSS properly'. No scenario says the CSS block stays whole and is not split at the base64 padding, or that a real '====' delimiter still splits blocks. The issue's domainPatterns symptom is also not covered at parser level.<br>tests/generators/utils/parse.tests.ts: **partial** (s6) — The test is the 'Base64 in CSS' parser regression test. It checks that the '==' padding inside a CSS line does not split the block, so the whole CSS is kept for example.com. It also checks that the '====' delimiter still separates the entries. Scenario 6 and scenario 4 cover only the visible outcomes: no error and proper processing. They do not state the block-splitting and CSS-preservation behaviour. | none |

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
| raw | ## Goal<br>A user who opens the reported site with Dark Reader sees the site-specific fixes applied to the page. At present, Dark Reader does not find these fixes. The ticket does not state which fixes apply to the site or how the page looks when they apply. The ticket says "the sites" but gives only one website address, so any other affected sites are unknown.<br><br>## Scenarios<br>- Given a Dark Reader version that has the #6738 fix, on Firefox Nightly, when the user goes to https://unix.stackexchange.com/questions/405783/why-does-man-print-gimme-gimme-gimme-at-0030, then the page shows the site-specific fixes for the site (the ticket does not state the expected appearance, so the author must supply it). | tests/generators/utils/parse.tests.ts:Index config: **partial** (s1) — The test checks that the generic '*' fix comes first, before the site fix. The issue implies this order, since it says the code should check fixes[0]. The scenario only says fixes are applied and does not state the order.<br>tests/generators/utils/parse.tests.ts:Domain appearing multiple times within the same record: **partial** (s1) — The test checks that the generic '*' fix comes first when a domain appears many times in one record. The scenario covers only the general case of fixes being found. It does not state the order.<br>tests/generators/utils/parse.tests.ts: **partial** (s1) — The hunk moves the '*' fix to the first position in all expected results and adds a test for this. The issue implies the first position through fixes[0]. The scenario does not state it.<br>tests/generators/utils/parse.tests.ts:The generic fix appears first: **partial** (s1) — The test checks that the generic '*' fix is first, before the wildcard and subdomain fixes. The issue implies this through fixes[0].url[0]. The scenario only says that fixes are shown for the site.<br>tests/generators/utils/parse.tests.ts:Domain appearing in multiple records: **partial** (s1) — The test checks that the '*' fix comes first, before the fixes of other records that match the domain. The scenario does not state the order. It only states that site fixes are applied. | none |
| improved:builtin | ## Goal<br>When a user opens the reported website with Dark Reader active, Dark Reader applies the fixes for that website. At this time, Dark Reader does not find these fixes, and the user does not see them. The ticket does not name the fixes or their visible result on the page. The ticket says "the sites" but gives only one website address, so the full list of affected websites is unknown. The ticket also does not give the Dark Reader settings for the failure, for example the theme mode.<br><br>## Scenarios<br>- Given Dark Reader is active in a build that includes the fix for #6738, when the user opens https://unix.stackexchange.com/questions/405783/why-does-man-print-gimme-gimme-gimme-at-0030, then the fixes for this website are applied to the page (the ticket does not name the visible result of these fixes, so the author must supply it before a tester can check this scenario). | tests/generators/utils/parse.tests.ts:Index config: **missing** — The issue implies the generic '*' fix should be first in the fixes array (fixes[0].url[0] === '*'). The test checks this order in the getSitesFixesFor result. The scenario only says the fixes are applied on the page and never mentions the order.<br>tests/generators/utils/parse.tests.ts:Domain appearing multiple times within the same record: **missing** — The test expects the '*' fix first in the result. The issue implies this order through the fixes[0] suggestion. No scenario states the order.<br>tests/generators/utils/parse.tests.ts: **missing** — The hunk moves the '*' fix to the first position in several expected results and adds a 'generic fix appears first' test. The issue implies this order. The scenario covers only the visible result, not the order.<br>tests/generators/utils/parse.tests.ts:The generic fix appears first: **missing** — The test checks that the generic '*' fix comes first. The issue implies this through the fixes[0] suggestion. The scenario does not state it.<br>tests/generators/utils/parse.tests.ts:Domain appearing in multiple records: **missing** — The test expects the '*' fix first, before the domain-specific records. The issue implies this order. No scenario states it. | none |

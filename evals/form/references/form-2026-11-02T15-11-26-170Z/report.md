# Form intent eval

- pass: intent; provider antigravity; model `gemini-3.8-flash-low`; judge `gemini-4-argon-low`; runs 1; started 2026-11-02T15:11:26.170Z
- F2P coverage: covered=1, partial=0.5; only tests whose behaviour the ISSUE states count (`not-in-issue` leaves the denominator). Spread = sd over runs.
- judge-errors are counted and excluded, never 0; `pending` = not reported. Function/API identifiers are info only, not a violation. Leaks should be 0 (proves the guard).

## Per source mode

| source | calls | call errors | F2P coverage | sd | missing | not-in-issue | unsupported/charter | parse first/nudged/degraded | scenarios | non-GWT | charters w/ paths | leaks | judge errors | tokens/call | s/call |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| raw | 6 | 0 | 50.0% | pending | 5 | 0 | 0.00 | 6/0/0 | 1.5 | 0 | 1 | 0 | 0 | pending | 7.5 |
| improved:builtin | 6 | 0 | 58.3% | pending | 5 | 0 | 0.00 | 6/0/0 | 1.5 | 0 | 1 | 0 | 0 | pending | 15.2 |

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
| raw | ## Goal<br>Components that declare emits using an extended TypeScript interface recognize the inherited events without triggering runtime warnings or failing to register them.<br><br>## Scenarios<br>- Given a component that defines its emitted events using a TypeScript interface extending a base emits interface, when the component emits an event defined on the base interface in development mode, then no Vue warning about an undeclared emitted event is logged to the console.<br>- Given a component that defines its emitted events using a TypeScript interface extending a base emits interface, when the component runs in production, then listeners for the extended base events are set up and receive the emitted events. | w/ type (interface w/ extends): **covered** (s1) — Both scenarios (and the goal) cover registering events from a TypeScript interface that extends a base emits interface via defineEmits so that both direct and inherited events are set up in the component's emits option without undeclared-event warnings. | none |
| improved:builtin | ## Goal<br>Components that declare emits using an interface extending another type interface recognize and support the inherited events without emitting runtime console warnings in development or failing to set up the extended emits in production.<br><br>## Scenarios<br>- Given a component using `defineEmits` with an interface extending a base emits type that declares `'input-event'` and `'change-event'`, when the component emits `'input-event'` or `'change-event'` in development mode, then no warning stating `Component emitted event "[event-name]" but it is neither declared in the emits option nor as an "on[Event-name]" prop` is displayed in the console.<br>- Given a component using `defineEmits` with an interface extending a base emits type that declares `'input-event'` and `'change-event'`, when the component runs in production mode, then the extended emits (`'input-event'` and `'change-event'`) are set up and handled as declared emits. | w/ type (interface w/ extends): **covered** (s2) — Both Charter scenarios cover `defineEmits` with an interface extending a base interface so that inherited events are set up as declared emits ( preventing dev warnings in Scenario 1 and ensuring extended emits are set up in Scenario 2). | none |

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
| raw | ## Goal<br>When using a property path (such as `props.xxx` or `info.icon`) as a component tag in a Vue template, the component resolves and renders its actual template content rather than being output as a literal HTML element with the property path name.<br><br>## Scenarios<br>- Given a component that renders a child component via an object property tag name (`<info.icon>`), when the component is rendered, then the output displays the component's rendered content `<div>hello</div>` instead of the literal tag `<info.icon></info.icon>`. | resolve namespaced component from props bindings (non-inline): **partial** (s1) — Scenario 1 covers rendering a namespaced component (`<info.icon>`), which is mentioned in the issue, though it omits the crucial `props` context stated in the issue title ('Can not use props.xxx type render component') and represented by `BindingTypes.PROPS` in the test.<br>resolve namespaced component from props bindings (inline): **partial** (s1) — Scenario 1 covers rendering a namespaced component (`<info.icon>`), which is mentioned in the issue, though it omits the crucial `props` context stated in the issue title ('Can not use props.xxx type render component') and represented by `BindingTypes.PROPS` in the test. | none |
| improved:builtin | ## Goal<br>When a component member accessed via property dot notation (such as `info.icon` passed via props) is used as a template tag, the rendered output displays the component's rendered content (`<div>hello</div>`) rather than emitting the raw literal property path tag (`<info.icon></info.icon>`).<br><br>## Scenarios<br>- Given a component tag referencing a prop's nested component property (e.g., `<info.icon />` where `info.icon` is a component rendering `<div>hello</div>`), when the template is rendered, then the output contains `<div>hello</div>` instead of `<info.icon></info.icon>`. | resolve namespaced component from props bindings (non-inline): **covered** (s1) — Scenario 1 covers rendering a component accessed via a prop's property dot notation (e.g., `<info.icon />` / `<Foo.Example/>` bound via props), which is what this test verifies for non-inline compilation.<br>resolve namespaced component from props bindings (inline): **covered** (s1) — Scenario 1 covers rendering a component accessed via a prop's property dot notation (e.g., `<info.icon />` / `<Foo.Example/>` bound via props), which is what this test verifies for inline compilation. | none |

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
| raw | ## Goal<br>When a select field (or a text field configured as a select) is disabled, its underlying `<input>` element includes the `disabled` attribute so that it reflects the disabled state in the DOM and does not submit its value during form submission.<br><br>## Scenarios<br>- Given a select field configured as disabled, when inspecting the rendered DOM, then the `<input>` element has the `disabled` attribute.<br>- Given a disabled select field inside a form, when the form is submitted, then the value of the disabled select field is not included in the submitted form data. | /home/material-ui/packages/material-ui/src/Select/Select.test.js:<Select /> accessibility sets disabled attribute in input when component is disabled: **covered** (s1) — Scenario 1 directly specifies that when a select field is configured as disabled, the underlying <input> element has the disabled attribute. | none |
| improved:builtin | ## Goal<br>When a select field (rendered via a disabled select component) is disabled, its underlying `<input>` element has the `disabled` attribute present so that it is properly marked as disabled in the DOM and its value is excluded upon form submission.<br><br>## Scenarios<br>- Given a select field rendered with the disabled state, when inspecting the underlying `<input>` element in the DOM, then the `<input>` element has the `disabled` attribute.<br>- Given a disabled select field inside an HTML form containing a value, when the form is submitted, then the disabled select field's value is omitted from the submitted form data. | /home/material-ui/packages/material-ui/src/Select/Select.test.js:<Select /> accessibility sets disabled attribute in input when component is disabled: **covered** (s1) — Scenario 1 directly specifies that when a select field is rendered in a disabled state, the underlying <input> element in the DOM has the disabled attribute. | none |

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
| raw | ## Goal<br>When a user interacts with a Switch that calls `preventDefault` in its click handler, the Switch does not change state or update its visual appearance.<br><br>## Scenarios<br>- Given a Switch configured with a click handler that calls `event.preventDefault()`, when the user clicks the Switch, then the Switch remains in its current visual state and does not toggle. | /home/material-ui/packages/material-ui/src/internal/SwitchBase.test.js:<SwitchBase /> handleInputChange() should not change checkbox state when event is default prevented: **covered** (s1) — Scenario 1 directly covers that when a click handler calls event.preventDefault(), the Switch does not change state or toggle. | none |
| improved:builtin | ## Goal<br>When a Switch component has an `onClick` handler that calls `preventDefault()`, clicking the Switch does not change its visual state.<br><br>## Scenarios<br>- Given a Switch configured with an `onClick` handler that calls `preventDefault()`, when the user clicks the Switch, then the Switch UI remains unchanged and does not update its state. | /home/material-ui/packages/material-ui/src/internal/SwitchBase.test.js:<SwitchBase /> handleInputChange() should not change checkbox state when event is default prevented: **covered** (s1) — Scenario 1 directly states that when `preventDefault()` is called in the click handler, the Switch does not update its state when clicked. | none |

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
| raw | ## Goal<br>Themes and custom CSS containing base64-encoded strings with `==` padding are properly parsed and applied so that the extension continues functioning normally and web page styling does not break.<br><br>## Scenarios<br>- Given the extension is enabled and custom CSS containing a base64 string padded with `==` (for an unmatched dummy URL) is added to a theme, when a tab with an enabled website is refreshed, then the website styles render properly without broken CSS.<br>- Given custom CSS containing a base64 string padded with `==` is configured, when the extension is toggled off and on repeatedly, then the extension functions properly without failing. | tests/generators/utils/parse.tests.ts:Base64 in CSS: **covered** (s1) — The test checks that site fixes configuration containing CSS with a `==`-padded base64 data URL is properly indexed and parsed without splitting on `==` or corrupting domain patterns, which is the core behaviour covered by Scenario 1 (and the Charter Goal).<br>tests/generators/utils/parse.tests.ts: **covered** (s1) — Same test hunk (`Base64 in CSS`): verifies `indexSitesFixesConfig` and `getSitesFixesFor` properly process custom CSS containing a base64 string padded with `==`, covered by Scenario 1. | none |
| improved:builtin | ## Goal<br>Custom themes containing CSS with base64-encoded strings padded with `==` are processed properly without breaking the extension or causing page styling issues, allowing the extension to continue functioning normally when toggled and when browsing pages.<br><br>## Scenarios<br>- Given the extension is enabled and configured with custom theme CSS containing a base64 string padded with `==` for an unrelated domain, when the user refreshes a tab on a website with the extension enabled, then the page renders without broken CSS and the extension continues to function properly when turned off and on repeatedly.<br>- Given the extension inspect view (background console) is open, when theme text containing a base64 string padded with `==` is loaded, then no `SyntaxError: Invalid regular expression` error is logged. | tests/generators/utils/parse.tests.ts:Base64 in CSS: **covered** (s1) — Tests that indexing and retrieving site fixes (`indexSitesFixesConfig` and `getSitesFixesFor`) properly processes a config containing a base64 string padded with `==` inside CSS without splitting on `==` or throwing a regex error, which corresponds to the charter scenarios covering proper processing of CSS with `==` base64 padding without `SyntaxError: Invalid regular expression`.<br>tests/generators/utils/parse.tests.ts: **covered** (s1) — Same test as above: verifies that `indexSitesFixesConfig` and `getSitesFixesFor` properly parse theme config blocks when CSS contains a base64 string padded with `==`, covered by the charter scenarios. | none |

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
| raw | ## Goal<br>Site fixes (custom styling or adjustments applied by the extension) are properly applied when visiting supported pages such as Unix Stack Exchange questions, rather than failing to load or apply.<br><br>## Scenarios<br>- Given Dark Reader is enabled, when navigating to a supported site (e.g., `https://unix.stackexchange.com/questions/405783/why-does-man-print-gimme-gimme-gimme-at-0030`), then the expected site-specific fixes are applied to the page.<br><br>**Note:** Found issue template boilerplate instructions and implementation/code references (`dynamic-theme.ts` line reference, code logic proposal, PR blocker references); please confirm the observable testing scope. | tests/generators/utils/parse.tests.ts:Index config: **missing** — The issue describes the bug around checking whether the generic '*' fix is at fixes[0] instead of fixes[fixes.length - 1] (and the charter omitted this as implementation detail, covering only high-level site navigation).<br>tests/generators/utils/parse.tests.ts:Domain appearing multiple times within the same record: **missing** — The test checks that the generic '*' fix is placed at index 0 of fixes rather than the end when a domain appears multiple times in a record; the issue discusses '*' being at fixes[0] vs fixes[fixes.length - 1], which the charter does not cover.<br>tests/generators/utils/parse.tests.ts: **missing** — The test diff verifies that the generic '*' fix is ordered first (at fixes[0]) rather than last across site fix lookups, corresponding to the issue's statement about fixes[0].url[0] !== '*' vs fixes[fixes.length - 1].url[0] !== '*', which is omitted from the charter.<br>tests/generators/utils/parse.tests.ts:The generic fix appears first: **missing** — The issue states that checking fixes[fixes.length - 1].url[0] !== '*' is wrong and likely meant to be fixes[0].url[0] !== '*' because the last entry could be from the non-qualified domain list; the charter does not cover generic '*' fix ordering/checking.<br>tests/generators/utils/parse.tests.ts:Domain appearing in multiple records: **missing** — The test checks that the '*' generic fix appears first in the returned fixes list when a domain appears in multiple records; the charter does not cover the '*' fix ordering/index behavior mentioned in the issue. | none |
| improved:builtin | ## Goal<br>Fixes configured for websites are correctly applied when visiting those sites, including pages such as Unix Stack Exchange, rather than failing to be found or applied.<br><br>## Scenarios<br>- Given Dark Reader is running, when navigating to `https://unix.stackexchange.com/questions/405783/why-does-man-print-gimme-gimme-gimme-at-0030`, then site fixes are applied (the specific visual/theme fixes intended for the site are unknown from the ticket).<br><br>**Note:** Embedded issue template commentary and duplicated report sections ("Improved description") were found in the ticket text; please confirm the scope. | tests/generators/utils/parse.tests.ts:Index config: **missing** — The issue indicates that the generic '*' fix entry should be at index 0 (`fixes[0].url[0] !== '*'`) rather than the end of the fixes array, which this test verifies, but the charter only covers the high-level browser navigation to unix.stackexchange.com.<br>tests/generators/utils/parse.tests.ts:Domain appearing multiple times within the same record: **missing** — The issue mentions that the '*' fix should be at `fixes[0]` and not `fixes[fixes.length - 1]`, which this test checks when a domain appears multiple times in a record, whereas the charter only includes the end-to-end site navigation scenario.<br>tests/generators/utils/parse.tests.ts: **missing** — The issue points out that the generic '*' fix is at `fixes[0]` rather than `fixes[fixes.length - 1]` (where non-qualified domains can appear), which these unit tests verify, but the charter omits this ordering/parsing behavior.<br>tests/generators/utils/parse.tests.ts:The generic fix appears first: **missing** — The issue specifically states that `fixes[0].url[0]` is the '*' entry while later entries can be other domains (including non-qualified domains), which this test directly checks, but the charter does not include a scenario for it.<br>tests/generators/utils/parse.tests.ts:Domain appearing in multiple records: **missing** — The issue describes the '*' fix being at `fixes[0]` instead of `fixes[fixes.length - 1]`, which this test verifies across multiple records, but the charter does not cover it. | none |

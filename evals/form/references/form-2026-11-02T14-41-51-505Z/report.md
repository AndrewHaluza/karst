# Form intent eval

- pass: intent; provider antigravity; model `gemini-3.8-flash-medium`; judge `gemini-4-argon-low`; runs 1; started 2026-11-02T14:41:51.505Z
- F2P coverage: covered=1, partial=0.5; only tests whose behaviour the ISSUE states count (`not-in-issue` leaves the denominator). Spread = sd over runs.
- judge-errors are counted and excluded, never 0; `pending` = not reported. Function/API identifiers are info only, not a violation. Leaks should be 0 (proves the guard).

## Per source mode

| source | calls | call errors | F2P coverage | sd | missing | not-in-issue | unsupported/charter | parse first/nudged/degraded | scenarios | non-GWT | charters w/ paths | leaks | judge errors | tokens/call | s/call |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| raw | 6 | 0 | 45.8% | pending | 5 | 0 | 0.00 | 6/0/0 | 1.5 | 0 | 1 | 0 | 0 | pending | 30.3 |
| improved:builtin | 6 | 0 | 60.0% | pending | 3 | 2 | 0.00 | 6/0/0 | 1.5 | 0 | 1 | 0 | 0 | pending | 98.5 |

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
| raw | ## Goal<br>A user running an application in development mode will no longer see console warnings stating that an emitted event is neither declared in the emits option nor as a prop when extended events (such as "input-event" or "change-event") are emitted. The observable outcome for production is unknown, as the ticket notes that extended emits are not set up on production but does not describe any observable console output, error message, or user-visible behavior.<br><br>## Scenarios<br>- Given an application running in development mode with a component configured with extended event definitions, when the component emits an extended event ("input-event" or "change-event"), then no console warning is displayed stating that the event is neither declared in the emits option nor as a prop.<br>- Given an application running in production mode with a component configured with extended event definitions, when the component emits an extended event, then the observable outcome is unknown because the ticket does not provide details on what is visibly observed in production. | w/ type (interface w/ extends): **partial** (s1) — The test verifies that defineEmits with an interface extending another base interface compiles to include both own and extended events in the component's emits option. Scenario 1 covers the dev runtime consequence of extended events being declared in the emits option (no console warning when emitted), but misses the direct setup/declaration of extended events in the emits option itself (and Scenario 2 dismisses the non-dev setup behavior as unknown rather than covering that extended emits are set up). | none |
| improved:builtin | ## Goal<br>When components emit events defined in extended emit interfaces, no undeclared event warnings are logged to the console in development mode, and extended events are recognized in production builds (the specific observable outcome in production is unknown).<br><br>## Scenarios<br>- Given a component configured with extended emit interfaces running in development mode, when an inherited event (such as `input-event` or `change-event`) is emitted, then the console does not display a warning stating that the event is neither declared in the emits option nor as a prop.<br>- Given a component configured with extended emit interfaces running in production mode, when an inherited event is emitted, then the extended event is recognized and set up (the specific observable outcome in production is unknown). | w/ type (interface w/ extends): **covered** (s1) — Both scenarios 1 and 2 cover the issue's requirement that `defineEmits` with an interface extending a base interface sets up both inherited and direct events in the component's `emits` option, preventing the undeclared-emits warning. | none |

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
| raw | ## Goal<br>The rendered output displays `<div>hello</div>` instead of the literal `<info.icon></info.icon>` tag. Any broader observable behavior, supported property syntax variations, or use cases beyond the provided minimal reproduction demo are unknown because the ticket does not specify them.<br><br>## Scenarios<br>- Given the minimal reproduction page is loaded, when the template renders, then the rendered output contains `<div>hello</div>` instead of `<info.icon></info.icon>`. | resolve namespaced component from props bindings (non-inline): **covered** (s1) — The issue describes rendering a component accessed via a prop property (`<info.icon></info.icon>` from `props.xxx`), which scenario 1 covers by verifying the reproduction renders the component (`<div>hello</div>`) rather than the literal tag (`<info.icon></info.icon>`). Non-inline compiler mode vs inline compiler mode is an internal implementation detail not specified separately in the issue.<br>resolve namespaced component from props bindings (inline): **covered** (s1) — The issue describes rendering a component accessed via a prop property (`<info.icon></info.icon>` from `props.xxx`), which scenario 1 covers by verifying the reproduction renders the component (`<div>hello</div>`) rather than the literal tag (`<info.icon></info.icon>`). | none |
| improved:builtin | ## Goal<br>When a component uses a prop property tag (such as `<info.icon>`) to render a component, the rendered output displays the child component's content (`<div>hello</div>`) instead of the unrendered tag (`<info.icon></info.icon>`). The scope for property access patterns beyond the single property case shown in the ticket is unknown.<br><br>## Scenarios<br>- Given a component provided with an object prop containing a component under a property (`info.icon` configured to render `<div>hello</div>`), when `<info.icon />` is rendered, then the rendered output displays `<div>hello</div>` rather than `<info.icon></info.icon>`. | resolve namespaced component from props bindings (non-inline): **covered** (s1) — Scenario 1 covers resolving and rendering a component accessed via a property on a prop (`<info.icon />`). The specific non-inline compiler transform output (`_unref($props["Foo"]).Example`) is an internal implementation detail not stated in the issue.<br>resolve namespaced component from props bindings (inline): **covered** (s1) — Scenario 1 covers resolving and rendering a component accessed via a property on a prop (`<info.icon />`). The specific inline compiler transform output (`_unref(__props["Foo"]).Example`) is an internal implementation detail not stated in the issue. | none |

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
| raw | ## Goal<br>When a select component is set to disabled, the underlying `<input>` element includes the `disabled` attribute, ensuring that the input is recognized as disabled in the browser and its value is not submitted with form data.<br><br>## Scenarios<br>- Given a disabled select component, when inspecting the rendered elements in the browser, then the `<input>` element has the `disabled` attribute.<br>- Given a form containing a disabled select component, when the form is submitted, then the disabled select field's value is omitted from the submitted form data. | /home/material-ui/packages/material-ui/src/Select/Select.test.js:<Select /> accessibility sets disabled attribute in input when component is disabled: **covered** (s1) — Scenario 1 directly specifies that when a select component is disabled, its rendered <input> element has the disabled attribute. | none |
| improved:builtin | ## Goal<br>When a disabled select field (such as `<TextField select disabled />`) is rendered, the underlying `<input>` element displays the `disabled` attribute in the DOM, preventing its value from being submitted with form data. Whether standalone `Select` components without `TextField` are also expected to exhibit this behavior is not specified in the ticket.<br><br>## Scenarios<br>- Given a disabled select component (`<TextField select disabled />`) rendered on the page, when inspecting the element in the browser DOM, then the `<input>` element has the `disabled` attribute.<br>- Given a disabled select component (`<TextField select disabled />`) within a form, when the form is submitted, then the field's value is omitted from the submitted form data. | /home/material-ui/packages/material-ui/src/Select/Select.test.js:<Select /> accessibility sets disabled attribute in input when component is disabled: **covered** (s1) — Scenario 1 directly specifies that when a disabled select component is rendered, the underlying <input> element has the disabled attribute in the DOM. | none |

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
| raw | ## Goal<br>When a Switch component is configured to prevent the default click behavior, clicking the Switch does not update or change its visual state. Whether this applies to both checked and unchecked initial states or interactions other than clicks is unknown.<br><br>## Scenarios<br>- Given a Switch configured to prevent default on click, when a user clicks the Switch, then the Switch does not change its visual state. | /home/material-ui/packages/material-ui/src/internal/SwitchBase.test.js:<SwitchBase /> handleInputChange() should not change checkbox state when event is default prevented: **covered** (s1) — Scenario 1 directly covers that preventing default on click prevents the switch state from changing. | none |
| improved:builtin | ## Goal<br>When a Switch element is configured to prevent the default action on click, clicking the Switch stops it from updating its state, keeping the Switch in its current visual state.<br><br>## Scenarios<br>- Given a Switch configured with a click handler that calls `preventDefault`, when a user clicks the Switch, then the Switch does not change state and its visual toggle state remains unchanged. | /home/material-ui/packages/material-ui/src/internal/SwitchBase.test.js:<SwitchBase /> handleInputChange() should not change checkbox state when event is default prevented: **covered** (s1) — Scenario 1 directly states that when `preventDefault` is called in the click handler, the Switch does not change state and its visual toggle state remains unchanged. | none |

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
| raw | ## Goal<br>A user can apply themes containing base64-encoded strings padded with `==` without breaking page styling or extension operation, allowing custom CSS to be processed correctly and the extension to toggle on and off normally.<br><br>## Scenarios<br>- Given the extension is enabled with custom theme CSS containing a base64-encoded string padded with `==` for a non-matching URL, when the user refreshes a tab on an enabled website, then the website CSS is not broken (the specific visual definition of "broken CSS" is unspecified in the ticket) and the custom CSS is ignored.<br>- Given a theme contains a base64-encoded string padded with `==`, when the user repeatedly toggles the extension off and on, then the extension continues to function properly (the specific symptoms of failing to function properly are unspecified in the ticket). | tests/generators/utils/parse.tests.ts:Base64 in CSS: **partial** (s1) — The test checks that `indexSitesFixesConfig` and `getSitesFixesFor` properly parse and return CSS containing base64 padding `==` without splitting on it (as described in the issue's Bug Description and Expected Behavior), whereas Scenario 1 only specifies the case where the custom CSS is for a non-matching URL and is ignored, omitting the matching/parsing case where the CSS block itself is returned intact.<br>tests/generators/utils/parse.tests.ts: **partial** (s1) — The test verifies that `indexSitesFixesConfig` and `getSitesFixesFor` properly parse a config block containing base64 `==` padding in CSS and return the intact CSS for a matching URL, whereas Scenario 1 only covers the non-matching URL case where the CSS is ignored and misses verifying that the CSS with `==` padding is parsed intact rather than split by the delimiter regex. | none |
| improved:builtin | ## Goal<br>Themes containing base64-encoded images padded with `==` are processed without breaking the extension, ensuring that websites with the extension enabled render styling correctly and that the extension can be toggled on and off normally.<br><br>## Scenarios<br>- Given the extension is enabled with theme text containing custom CSS with a `==` padded base64-encoded image for a non-matching site, when a user refreshes an open tab with the extension enabled, then the page renders without broken CSS and the non-matching theme entry is ignored.<br>- Given the extension is configured with theme text containing a `==` padded base64-encoded image, when a user turns the extension off and on repeatedly, then the extension toggles and functions normally. | tests/generators/utils/parse.tests.ts:Base64 in CSS: **partial** (s1) — The test checks that site fixes configuration containing CSS with a '=='-padded base64 image is parsed without splitting on '==' and returns the intact CSS fix for a matching site ('www.example.com' matching 'example.com'). Scenario 1 covers processing custom CSS with '=='-padded base64 images without breaking, but only specifies the non-matching site case where the entry is ignored, rather than applying/returning the intact CSS when the site matches.<br>tests/generators/utils/parse.tests.ts: **partial** (s1) — The test checks that site fixes configuration containing CSS with a '=='-padded base64 image is parsed without splitting on '==' and returns the intact CSS fix for a matching site ('www.example.com' matching 'example.com'). Scenario 1 covers processing custom CSS with '=='-padded base64 images without breaking, but only specifies the non-matching site case where the entry is ignored, rather than applying/returning the intact CSS when the site matches. | none |

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
| raw | ## Goal<br>When a user visits `https://unix.stackexchange.com/questions/405783/why-does-man-print-gimme-gimme-gimme-at-0030` with the extension running, the site-specific fixes are applied to the page rather than missing. The ticket does not specify what the visual fixes are, what styling changes should be observed, or which other websites are intended by "the sites."<br><br>## Scenarios<br>- Given the extension is enabled in the browser, when a user navigates to `https://unix.stackexchange.com/questions/405783/why-does-man-print-gimme-gimme-gimme-at-0030`, then site fixes are applied to the page (the exact visual appearance and elements modified by the fixes are unknown).<br><br>**Note:** Embedded issue template instructions were found in the ticket text; please confirm if this content is within scope. | tests/generators/utils/parse.tests.ts:Index config: **missing** — The issue describes that the generic '*' fix entry should be at index 0 (`fixes[0].url[0] !== '*'`) rather than the last entry (`fixes[fixes.length - 1]`), which this test verifies by checking that the `url: ['*']` fix is returned first, but the charter only covers visiting unix.stackexchange.com in a browser.<br>tests/generators/utils/parse.tests.ts:Domain appearing multiple times within the same record: **missing** — The issue mentions that the '*' fix should be at `fixes[0]` rather than `fixes[fixes.length - 1]` (while specific/non-qualified domains follow), which this test checks when a domain appears multiple times in a record, but the charter does not cover fix ordering or `url: ['*']` placement.<br>tests/generators/utils/parse.tests.ts: **missing** — The test suite changes verify that the generic '*' fix is placed first (`fixes[0]`) instead of last (`fixes[fixes.length - 1]`), matching the issue's description of `fixes[0].url[0] !== '*'` vs `fixes[fixes.length - 1].url[0] !== '*'`, which the charter omits.<br>tests/generators/utils/parse.tests.ts:The generic fix appears first: **missing** — The issue explicitly discusses `fixes[0].url[0] !== '*'` vs `fixes[fixes.length - 1].url[0] !== '*'` and how the last entry could be a domain from the non-qualified domain list, which this test directly checks, but the charter misses it.<br>tests/generators/utils/parse.tests.ts:Domain appearing in multiple records: **missing** — The issue states that the '*' fix check at the end of `fixes` is wrong because '*' should be at `fixes[0]`, which this test verifies by asserting the `url: ['*']` entry comes first before domain-specific records, and the charter does not cover this. | none |
| improved:builtin | ## Goal<br>When a user visits https://unix.stackexchange.com/questions/405783/why-does-man-print-gimme-gimme-gimme-at-0030 with Dark Reader active, the site fixes are applied to the page rather than missing. The ticket does not specify what the fixes actually alter or how the page should visually render, leaving the exact observable changes unknown.<br><br>## Scenarios<br>- Given Dark Reader is running in the browser, when navigating to https://unix.stackexchange.com/questions/405783/why-does-man-print-gimme-gimme-gimme-at-0030, then site fixes are applied (the specific visual modifications to observe are unknown).<br><br>**Note:** Duplicate pasted content under "Improved description:" was found; please confirm scope. | tests/generators/utils/parse.tests.ts:Index config: **missing** — The issue notes that the '*' fix entry should be at fixes[0] rather than fixes[fixes.length - 1], which this test checks, but the charter only describes a browser scenario on unix.stackexchange.com.<br>tests/generators/utils/parse.tests.ts:Domain appearing multiple times within the same record: **not-in-issue** — The issue does not mention domains appearing multiple times within the same record in site fixes parsing.<br>tests/generators/utils/parse.tests.ts: **missing** — The issue mentions that the '*' fix should be at index 0 of fixes (fixes[0].url[0] !== '*') instead of the last entry, which the test patch verifies, whereas the charter only covers visiting unix.stackexchange.com.<br>tests/generators/utils/parse.tests.ts:The generic fix appears first: **missing** — The issue states that the '*' (generic) fix entry is at fixes[0] rather than fixes[fixes.length - 1] (where non-qualified domain entries are placed), which this test checks, but the charter does not cover it.<br>tests/generators/utils/parse.tests.ts:Domain appearing in multiple records: **not-in-issue** — The issue does not mention domains appearing across multiple records in site fixes parsing. | none |

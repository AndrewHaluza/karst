# Form intent eval

- pass: intent; provider claude; model `claude-sonnet-5-5`; judge `claude-opus-5-5`; runs 1; started 2026-11-06T00:31:21.439Z
- F2P coverage: covered=1, partial=0.5; only tests whose behaviour the ISSUE states count (`not-in-issue` leaves the denominator). Spread = sd over runs.
- judge-errors are counted and excluded, never 0; `pending` = not reported. Function/API identifiers are info only, not a violation. Leaks should be 0 (proves the guard).

## Per source mode

| source | calls | call errors | F2P coverage | sd | missing | not-in-issue | unsupported/charter | parse first/nudged/degraded | scenarios | non-GWT | charters w/ paths | leaks | judge errors | tokens/call | s/call |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| raw | 6 | 0 | 66.7% | pending | 0 | 3 | 0.33 | 6/0/0 | 3.8 | 0 | 1 | 0 | 0 | pending | 14.5 |
| improved:builtin | 6 | 0 | 80.0% | pending | 0 | 7 | 0.17 | 5/1/0 | 4.0 | 0 | 2 | 0 | 0 | pending | 27.9 |

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
| raw | ## Goal<br>A component declares its events with a type that extends another event type. After the fix, the component accepts the inherited events and its own events. A user sees no Vue warning for any of them in development. A user sees the parent listener receive every event in a production build. The ticket does not state which other ways to extend an event type must work. It does not state whether the base type must be in a different file from the component. It does not state which build tools to test.<br><br>## Scenarios<br>- Given a component declares its events with a type that extends a base type, and a parent listens for `input-event`, when the component emits `input-event` with a string value, then the parent listener runs once with that value.<br>- Given the same component, and a parent listens for `change-event`, when the component emits `change-event` with a string value, then the parent listener runs once with that value.<br>- Given the same component, and a parent listens for `blur-event` and `focus-event`, when the component emits each event with a string value, then the parent listener for each event runs once with that value.<br>- Given the same component runs in a development build, when the component emits `input-event`, `change-event`, `blur-event`, and `focus-event`, then the browser console shows no warning that the event is "neither declared in the emits option nor as an" `onXxx` prop.<br>- Given the same component runs in a development build, and the parent attaches no listener, when the component emits `input-event`, then the browser console shows no Vue warning.<br>- Given the same component runs in a production build, and a parent listens for `input-event` and `change-event`, when the component emits each event with a string value, then the parent listener for each event runs once with that value.<br>- Given a component declares its events with a type that does not extend another type, when the component emits a declared event, then the behavior is the same as before the fix. | w/ type (interface w/ extends): **covered** (s1) — The test checks that an interface with extends yields both inherited and own events as declared emits. The issue states this expectation, and scenarios 1 to 4 and 6 state the behaviour at the black-box level: inherited and own events are accepted without a warning. The exact compiled output order is an implementation detail that the issue does not state. | s5: The issue does not state a scenario with no parent listener as a separate criterion, and it does not require the absence of every Vue warning. However, the issue warning text implies that a declared event gives no warning when no prop exists, so this scenario is only weakly supported.<br>s7: The issue does not mention a type without extends and does not state a requirement that the behaviour stays the same. |
| improved:builtin | ## Goal<br>A component declares its events with a type that extends a base event type. The component then treats the events from the base type and the events from the extending type as declared events. The component emits each of them without an "undeclared event" warning, and a parent component receives each of them.<br><br>## Scenarios<br>- Given a component declares its events with a type that extends a base type, and the base type has the events "input-event" and "change-event", when the component emits "input-event" in a development build, then the browser console shows no warning that the event is not declared.<br>- Given the same component, when the component emits "change-event" in a development build, then the browser console shows no warning that the event is not declared.<br>- Given the same component, and a parent component that listens for "input-event", when the component emits "input-event" with a string value, then the parent listener runs and receives that value.<br>- Given the same component, and a parent component that listens for "change-event", when the component emits "change-event" with a string value, then the parent listener runs and receives that value.<br>- Given the same component in a production build, and a parent component that listens for "input-event" and "change-event", when the component emits each event, then the parent listener for each event runs.<br>- Given the extending type adds the events "blur-event" and "focus-event", when the component emits each of them, then the browser console shows no warning, and a parent listener for each event receives the value.<br><br>## Not in scope<br>- The ticket gives no system information (OS, browser, build tool). The environments to test are unknown.<br>- The ticket does not say whether an extension of more than one level, or an extension of more than one base type, must work. This behavior is unknown. | w/ type (interface w/ extends): **covered** (s1) — The test checks that the events from a base interface and an extending interface both become declared emits. The issue states this behaviour. Scenarios 1 and 6 state that base and extending events are declared and cause no warning. The exact compiled output and event order are implementation details that the issue does not state. | none |

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
| raw | ## Goal<br>A component that a template references with a dotted name must render as that component. Today the output shows the literal tag `<info.icon></info.icon>`. After the fix, the output shows `<div>hello</div>`. The ticket reports Vue version 3.3.4. The ticket text does not contain the reproduction setup, because it only gives a link. The ticket does not say if `info` is a prop, as the title `props.xxx` suggests, or another kind of value. The ticket does not say if the check applies to browser output, server output, or both.<br><br>## Scenarios<br>- Given a template that uses the tag `<info.icon>`, and `info.icon` is a component that renders "hello" in a `div`, when the page renders, then the output is `<div>hello</div>`.<br>- Given the same template and the same component, when the page renders, then the output does not contain the text `<info.icon></info.icon>`. | resolve namespaced component from props bindings (non-inline): **partial** (s1) — The issue title states that a props.xxx component must render, and the scenario checks a dotted tag that renders as the component. The scenario does not state that the component comes from a prop. The test also checks the non-inline generated tag `_unref($props["Foo"]).Example` and no RESOLVE_COMPONENT helper, which the issue does not state.<br>resolve namespaced component from props bindings (inline): **partial** (s1) — The issue title states that a props.xxx component must render, and the scenario checks a dotted tag that renders as the component. The scenario does not state that the component comes from a prop. The test also checks the inline generated tag `_unref(__props["Foo"]).Example` and no RESOLVE_COMPONENT helper, which the issue does not state. | none |
| improved:builtin | ## Goal<br>A user renders a component whose type comes from a dotted property path, such as `info.icon`. The user sees the rendered content of that component, `<div>hello</div>`. The user does not see the literal tag `<info.icon></info.icon>`. The ticket gives the exact reproduction only in a link. It does not state the component code, the template form, or the fixed version. It reports the problem on Vue 3.3.4.<br><br>## Scenarios<br>- Given the reproduction from the ticket, when the user renders the component, then the output is `<div>hello</div>`.<br>- Given the reproduction from the ticket, when the user renders the component, then the output does not contain `<info.icon></info.icon>`.<br><br>## Not in scope<br>- The ticket names no excluded behavior. | resolve namespaced component from props bindings (non-inline): **not-in-issue** — The test checks the compiler output `_unref($props["Foo"]).Example` and the absence of the RESOLVE_COMPONENT helper in non-inline mode. The issue states only the render output for a props.xxx component type. The issue text does not state compiler output, helper use, or inline modes.<br>resolve namespaced component from props bindings (inline): **not-in-issue** — The test checks the compiler output `_unref(__props["Foo"]).Example` and the absence of the RESOLVE_COMPONENT helper in inline mode. The issue states only the render output for a props.xxx component type. The issue text does not state compiler output, helper use, or inline modes. | none |

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
| raw | ## Goal<br>When a user sets a select field to disabled, the input element of the field has the disabled attribute. A regular disabled text field already behaves this way. A user or a test can then see that the field is disabled from the input element itself.<br><br>## Scenarios<br>- Given a select text field with the disabled setting on, when a user inspects the input element in the browser, then the input element has the disabled attribute.<br>- Given a disabled select text field inside a form, when the user submits the form, then the submitted data does not include the value of the select field.<br>- Given a regular disabled text field and a disabled select text field, when a user inspects the input element of each field, then both input elements show the disabled attribute.<br><br>## Not in scope<br>- Unknown: the ticket does not say if the existing `aria-disabled="true"` and the disabled styling classes on the div must stay or go. | /home/material-ui/packages/material-ui/src/Select/Select.test.js:<Select /> accessibility sets disabled attribute in input when component is disabled: **covered** (s1) — The issue states that the input element of a disabled select must have the disabled attribute. Scenario 1 states this outcome. The test hunk is not available, so this decision uses the test name. | none |
| improved:builtin | ## Goal<br>A select field that the user sets to disabled shows the same disabled state on its input element as a regular disabled text field. A user who inspects the field sees the `disabled` attribute on the `<input>` element. The ticket also states that the field value is then not sent when the user submits a form.<br><br>## Scenarios<br>- Given a select field set to disabled, when the user inspects the `<input>` element of the field in the browser, then the `<input>` element has the `disabled` attribute.<br>- Given a select field set to disabled inside a form, when the user submits the form, then the form data does not include the value of the select field.<br>- Given a regular text field set to disabled, when the user inspects its `<input>` element, then the `<input>` element has the `disabled` attribute. The select field matches this behavior.<br>- Given a select field set to disabled, when the user views the field, then the field still shows as disabled (the ticket names the classes and `aria-disabled="true"` on the surrounding `div` as present today).<br><br>## Not in scope<br>- The ticket does not state if `aria-disabled="true"` and the disabled classes stay on the surrounding `div`. Confirm the expected result.<br>- The ticket does not state the behavior of a select field that is not disabled. Confirm the expected result.<br>- The ticket does not state the behavior with a native select (`select` element). It only says the native select is already disabled.<br>- The ticket does not state the React version, the browser, or the TypeScript version. | /home/material-ui/packages/material-ui/src/Select/Select.test.js:<Select /> accessibility sets disabled attribute in input when component is disabled: **covered** (s1) — The issue states that the input element of a disabled select should have the disabled prop. Scenario 1 states this exact outcome. The test hunk is not available, so this judgment uses the test name. | s4: The issue describes the classes and aria-disabled on the div only as current behavior. It does not state that the field must still show as disabled after the change, and the charter's own Not in scope section says the issue does not state if they stay. |

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
| raw | ## Goal<br>A user clicks a Switch that has an `onClick` handler. The handler calls `event.preventDefault()`. After the click, the Switch must keep its previous visual state, on or off. Currently the Switch changes state anyway. The ticket does not state these points: keyboard use, a controlled Switch, a disabled Switch, and whether the `onChange` handler runs after `preventDefault`.<br><br>## Scenarios<br>- Given a Switch that is off and has an `onClick` handler that calls `event.preventDefault()`, when the user clicks the Switch, then the Switch stays off.<br>- Given a Switch that is on and has an `onClick` handler that calls `event.preventDefault()`, when the user clicks the Switch, then the Switch stays on.<br>- Given a Switch that has an `onClick` handler that does not call `event.preventDefault()`, when the user clicks the Switch, then the Switch changes state. | /home/material-ui/packages/material-ui/src/internal/SwitchBase.test.js:<SwitchBase /> handleInputChange() should not change checkbox state when event is default prevented: **covered** (s1) — The issue states that preventDefault in the onClick handler must stop the element from updating. Scenario 1 states that a Switch that is off stays off after a click with preventDefault. The test hunk is not available, so this verdict uses the test name only. | none |
| improved:builtin | ## Goal<br>When a user clicks a Switch and its `onClick` handler calls `event.preventDefault()`, the Switch must not change state. The user must see the Switch stay in the same position and appearance. Today the Switch changes state anyway. The ticket does not say if the Switch is controlled or uncontrolled. The ticket gives no live example.<br><br>## Scenarios<br>- Given a Switch is off and its `onClick` handler calls `event.preventDefault()`, when the user clicks the Switch, then the Switch stays off.<br>- Given a Switch is on and its `onClick` handler calls `event.preventDefault()`, when the user clicks the Switch, then the Switch stays on.<br>- Given a Switch is off and its `onClick` handler calls `event.preventDefault()`, when the user clicks the Switch two times, then the Switch is off after each click.<br>- Given a Switch has an `onClick` handler that does not call `event.preventDefault()`, when the user clicks the Switch, then the Switch changes to the opposite state. | /home/material-ui/packages/material-ui/src/internal/SwitchBase.test.js:<SwitchBase /> handleInputChange() should not change checkbox state when event is default prevented: **covered** (s1) — The test name states that a default-prevented event must not change the checked state. The issue states this behaviour for the Switch, and scenario 1 states it. No test hunk was found, so this result comes from the test name only. | none |

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
| raw | ## Goal<br>A user adds custom CSS to a theme. The CSS contains a base64 string that ends with `==`. The extension must process this CSS correctly. The extension must not break. The pages must show no broken CSS. The extension must continue to work when the user enables and disables it.<br><br>## Scenarios<br>- Given the extension is enabled and a theme contains the entry from the ticket (site `thisisnotarealwebsite.dummy`, a base64 `url(...)` ending in `==`, and the line `IGNORE INLINE STYLE`), when the user refreshes a tab on a website that has Dark Reader enabled, then the page shows no broken CSS.<br>- Given the same theme, when the user opens the background inspect view and refreshes a tab, then the console shows no `Invalid regular expression` error.<br>- Given the same theme, when the user disables and enables the extension several times, then the extension switches state each time and the pages keep the correct theme.<br>- Given the same theme, when the user views a tab whose URL does not match `thisisnotarealwebsite.dummy`, then the custom CSS of that entry is not applied to the page.<br>- Given the same theme without the `IGNORE INLINE STYLE` line, when the user refreshes a tab on a website that has Dark Reader enabled, then the page shows no broken CSS and the extension keeps working.<br><br>## Not in scope<br>- The ticket does not say what the "broken CSS" looks like. It does not say what "does not function properly" means. The charter cannot define these symptoms.<br>- The ticket does not say what happens on a tab that matches `thisisnotarealwebsite.dummy`. It says only that the CSS is ignored when no tab matches.<br>- The ticket does not say whether other base64 forms or other `=` sequences in custom CSS must work. | tests/generators/utils/parse.tests.ts:Base64 in CSS: **partial** (s2) — The hunk for this name is listed under Test 2. The issue states that CSS with a base64 string padded by `==` must be properly processed and that the `==` must not act as a delimiter. Scenario 2 checks only that no regex error occurs. No scenario checks that the blocks split correctly or that the base64 CSS stays intact in the fix for a matching URL, and the charter puts matching tabs out of scope.<br>tests/generators/utils/parse.tests.ts: **partial** (s2) — The test checks that the parser splits blocks correctly and returns the wildcard fix and the example.com fix with the full base64 CSS. The issue states the delimiter fault and the need for proper processing. Scenarios 1, 2 and 4 check only for no error, no broken CSS and no CSS on non-matching tabs, not the parsed result for a matching site. | none |
| improved:builtin | ## Goal<br>After the fix, a theme that contains custom CSS with a base64 string padded with `==` does not break the extension. The extension keeps its normal function. Dark Reader processes the custom CSS correctly. The CSS has no effect on a tab that does not match the site in the entry. The ticket does not describe the "broken CSS" on the page. It also does not define "does not function properly". It does not say what a matching site shows. It does not say if browsers other than Chrome and Opera are affected.<br><br>## Scenarios<br>- Given the extension is enabled and the theme contains the dummy entry from the ticket, when the user refreshes a tab on a site with Dark Reader enabled, then the page shows no broken CSS.<br>- Given the same theme text, when the user opens the background inspect view and refreshes a tab, then the console shows no "Invalid regular expression" error.<br>- Given the same theme text, when the user turns the extension off and on several times, then the extension changes state each time and the page changes accordingly.<br>- Given the same theme text, when no open tab matches `thisisnotarealwebsite.dummy`, then the custom CSS has no visible effect on any open tab.<br>- Given the same theme text without the `IGNORE INLINE STYLE` line, when the user refreshes a tab on a site with Dark Reader enabled, then the result is the same as with the line.<br>- Given the theme contains a `background-image` rule with a `url('data:image/png;base64,…==')` value, when the user refreshes a tab on a site with Dark Reader enabled, then the extension keeps working and the page shows no broken CSS.<br>- Given the same theme text, when the user repeats the steps in Chrome and in Opera, then the result is the same in both browsers. | tests/generators/utils/parse.tests.ts:Base64 in CSS: **partial** (s6) — The issue states that the `==` padding must not break the parsing of the CSS and that the CSS is properly processed. Scenario 6 uses the same kind of base64 rule, but it checks only that the extension keeps working and that the page has no broken CSS. No scenario checks that the blocks split correctly or that a matching site gets the complete CSS, and the charter explicitly leaves the matching-site result undefined.<br>tests/generators/utils/parse.tests.ts: **partial** (s6) — This is the same regression test as the named test. The charter covers the absence of a crash and of a regex error for a base64 value padded with `==`. It does not state that a fix for a matching URL keeps the base64 CSS intact in its own block, separate from the `*` block. | none |

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
| raw | ## Goal<br>A user opens the Stack Exchange page named in the ticket with Dark Reader on. Dark Reader then applies the fixes for that site. Today it does not find the fixes, and the page shows no fix effects. The ticket does not say which fixes exist for the site. It does not say how the page looks when the fixes apply. It does not say if other sites have the same fault.<br><br>## Scenarios<br>- Given Dark Reader is on and uses the dynamic theme, when the user opens `https://unix.stackexchange.com/questions/405783/why-does-man-print-gimme-gimme-gimme-at-0030`, then Dark Reader applies the fixes for the site.<br>- Given the same state, when the user looks at the page, then the page shows the effect of the fixes. The ticket does not define this effect, so the expected look is unknown.<br>- Given the same state, when the user opens the page, then the result is not the "Fixes aren't found" result that the ticket reports.<br><br>## Not in scope<br>- Issue #6738. The ticket names it as a separate fix and does not describe it.<br>- Issue #6737. The ticket says this fix blocks it and does not describe it. | tests/generators/utils/parse.tests.ts:Index config: **not-in-issue** — The test checks the order of the array that getSitesFixesFor returns, with the generic '*' fix first. The issue suggests that the code checks fixes[0], but it does not state this parser output or index behaviour. The charter scenarios only check browser results on one site.<br>tests/generators/utils/parse.tests.ts:Domain appearing multiple times within the same record: **not-in-issue** — The test checks the '*' fix position and the handling of a domain that occurs many times in one record. The issue does not mention duplicate domains in a record or the returned order for this case.<br>tests/generators/utils/parse.tests.ts: **partial** (s1) — The issue implies that the generic fix is at fixes[0] and that site fixes must apply. Scenario 1 states only the end result on the named site. It does not state the generic-fix-first order, which is the key part of the file's tests.<br>tests/generators/utils/parse.tests.ts:The generic fix appears first: **partial** (s1) — The issue suggests the check fixes[0].url[0] !== '*', so it implies the '*' fix is first. Scenario 1 touches the result that fixes apply, but no scenario states the generic-fix-first order.<br>tests/generators/utils/parse.tests.ts:Domain appearing in multiple records: **not-in-issue** — The test checks the fixes that return when one domain occurs in many records, and the order of these fixes. The issue does not mention a domain in many records. | none |
| improved:builtin | ## Goal<br>After the fix, Dark Reader finds and applies the site fixes for the page at `unix.stackexchange.com`. Before the fix, Dark Reader does not find the fixes, and the page does not show them. The ticket does not say what the fixes change on the page. The ticket does not say how a user sees that Dark Reader "found" the fixes. The ticket does not describe the change in #6738. The ticket names no other site with the problem.<br><br>## Scenarios<br>- Given Dark Reader is on in Firefox Nightly 93.0a1 on Arch Linux, and the change from #6738 is present, when the user opens `https://unix.stackexchange.com/questions/405783/why-does-man-print-gimme-gimme-gimme-at-0030`, then Dark Reader applies the fixes for that site to the page. | tests/generators/utils/parse.tests.ts:Index config: **not-in-issue** — The test requires that getSitesFixesFor returns the '*' fix before the 'example.com' fix. The ISSUE implies that fixes[0] is the generic entry only as a tentative suggestion. It does not state a required return order, and the charter states only that fixes apply on one site.<br>tests/generators/utils/parse.tests.ts:Domain appearing multiple times within the same record: **not-in-issue** — The test checks the order of results when a domain appears more than once in one record, with '*' first. The ISSUE does not mention repeated domains in a record or a required result order.<br>tests/generators/utils/parse.tests.ts: **not-in-issue** — The file-level test checks parser result order for several configs, with the generic fix first. The ISSUE states only a tentative code suggestion about fixes[0] and the visible symptom that fixes are not found on the site. It does not state the parser contract.<br>tests/generators/utils/parse.tests.ts:The generic fix appears first: **not-in-issue** — The test requires the '*' fix first in the getSitesFixesFor result. The ISSUE questions the check of the last entry and suggests fixes[0] with 'likely' and a question mark. It does not state this ordering as required behaviour, and the charter has no scenario for it.<br>tests/generators/utils/parse.tests.ts:Domain appearing in multiple records: **not-in-issue** — The test checks the order of results when a domain appears in multiple records, with '*' first. The ISSUE does not mention a domain in multiple records or a required result order. | none |

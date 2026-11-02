# Form intent eval

- pass: intent; provider claude; model `claude-haiku-5-5`; judge `claude-sonnet-5-5`; runs 1; started 2026-11-02T15:51:52.246Z
- F2P coverage: covered=1, partial=0.5; only tests whose behaviour the ISSUE states count (`not-in-issue` leaves the denominator). Spread = sd over runs.
- judge-errors are counted and excluded, never 0; `pending` = not reported. Function/API identifiers are info only, not a violation. Leaks should be 0 (proves the guard).

## Per source mode

| source | calls | call errors | F2P coverage | sd | missing | not-in-issue | unsupported/charter | parse first/nudged/degraded | scenarios | non-GWT | charters w/ paths | leaks | judge errors | tokens/call | s/call |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| raw | 6 | 0 | 37.5% | pending | 5 | 0 | 0.50 | 6/0/0 | 3.0 | 0 | 2 | 0 | 0 | pending | 13.0 |
| improved:builtin | 6 | 0 | 37.5% | pending | 5 | 0 | 0.83 | 6/0/0 | 3.3 | 0 | 3 | 0 | 0 | pending | 25.1 |

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
| raw | ## Goal<br>With Vue 3.3.4, a component whose `defineEmits` type extends a base emits interface should accept the inherited events as declared. Emitting an inherited event (`input-event`, `change-event`) should not produce the dev-mode warning "neither declared in the emits option nor as an onXxx prop", and a parent's listener for that event should receive the payload, in both dev and prod builds. The ticket does not state whether the component's own directly declared events (`blur-event`, `focus-event`) already behave correctly, and it does not state the expected prod behavior explicitly, so those are not asserted here.<br><br>## Scenarios<br>- Given a component with `defineEmits<ComponentEmits>()` where `ComponentEmits extends BaseEmits` (BaseEmits declares `input-event` and `change-event`), when the app runs in dev mode and the component emits `input-event` with `"abc"`, then the browser console shows no `[Vue warn]: Component emitted event "input-event"` message.<br>- Given the same component in dev mode, when the component emits `change-event` with `"abc"`, then the browser console shows no `[Vue warn]: Component emitted event "change-event"` message.<br>- Given a parent that listens to the component's `input-event` with a handler that records its argument, when the component emits `input-event` with `"abc"`, then the parent handler runs once with `"abc"`.<br>- Given a parent that listens to the component's `change-event` with a handler that records its argument, when the component emits `change-event` with `"abc"`, then the parent handler runs once with `"abc"`.<br>- Given the same component and parent in a production build, when the component emits `input-event` with `"abc"`, then the parent handler runs once with `"abc"`.<br>- Given the same component and parent in a production build, when the component emits `change-event` with `"abc"`, then the parent handler runs once with `"abc"`. | w/ type (interface w/ extends): **partial** (s1) — Issue states inherited events should be declared as emits (no warning, setup in prod). Scenarios 1-6 check runtime no-warning and handler behaviour, which implies inherited events are in emits, but none states compile output must include both own and inherited events in emits. Exact order ['bar','foo'] is not in issue, but inherited-event declaration is. | none |
| improved:builtin | ## Goal<br>A component whose events are inherited from a shared base event interface emits those inherited events without development-console warnings, and the parent's listener receives them. The ticket does not say what production builds must do beyond "defineEmits can support extended events." It also does not say whether the warnings must disappear in every build mode, and the linked minimal reproduction was not checked.<br><br>## Scenarios<br>- Given a component built with Vue 3.3.4 whose events extend a base event set containing `input-event` and `change-event`, and that also declares `blur-event` and `focus-event`, when it runs in development mode and emits `input-event` with a string value, then the console shows no warning that reads "Component emitted event \\"input-event\\" but it is neither declared in the emits option nor as an \\"onInput-event\\" prop."<br>- Given the same component, when it runs in development mode and emits `change-event` with a string value, then the console shows no warning that reads "Component emitted event \\"change-event\\" but it is neither declared in the emits option nor as an \\"onChange-event\\" prop."<br>- Given the same component, when it runs in development mode and emits `blur-event` or `focus-event` with a string value, then the console shows no "neither declared in the emits option" warning for either event.<br>- Given the same component, when a parent attaches a listener for `input-event` and the component emits `input-event` with "abc", then the parent's listener runs and receives "abc".<br>- Given the same component, when a parent attaches a listener for `change-event` and the component emits `change-event` with "abc", then the parent's listener runs and receives "abc".<br>- Given the same component running as a production build, when it emits `input-event` or `change-event` with a string value, then the parent's matching listener runs and receives that value. | w/ type (interface w/ extends): **partial** (s1) — Charter scenarios cover inherited events not warning and listener receiving them, which is the behaviour the issue states. They never say the compiled emits option lists both base and own events ("bar" and "foo"), and the compile-time output is not described. | s6: Issue says production emits are not set up, but it does not specify a production-build listener outcome. The charter itself admits the ticket is silent on this. |

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
| raw | ## Goal<br>A user who renders a component through a dotted name taken from props sees that component's real output on the page, not an unknown element named after the dotted path. The ticket reports `<info.icon></info.icon>` where `<div>hello</div>` is expected, on Vue 3.3.4. The reproduction code is only linked, not quoted, so the exact template is unknown here.<br><br>## Scenarios<br>- Given the minimal reproduction on Vue 3.3.4 that renders a component through a dotted `props`-based name, when the page renders, then the output is `<div>hello</div>`.<br>- Given the same reproduction, when the rendered HTML is inspected, then no `<info.icon>` element or text appears in the output.<br><br>## Not in scope<br>- Vue versions other than 3.3.4: the ticket names only this version.<br>- Dotted-name forms beyond the linked reproduction: the ticket does not describe others. | resolve namespaced component from props bindings (non-inline): **partial** (s1) — Issue states rendering a dotted props-based component should give the real output rather than <info.icon>. Scenarios cover that end-to-end outcome. They never mention the compiler resolving the tag via props binding without RESOLVE_COMPONENT in non-inline mode (`_unref($props["Foo"]).Example`).<br>resolve namespaced component from props bindings (inline): **partial** (s1) — Scenarios cover the rendered outcome for a dotted props-based component. They do not state the inline-mode compile behaviour (`_unref(__props["Foo"]).Example`, no RESOLVE_COMPONENT). | s2: Issue only says the output is actually `<info.icon></info.icon>` and expects `<div>hello</div>`. Scenario 2 restates this as 'no <info.icon> element appears', which is a reasonable split, so it is supported. Flagged only because it pins the exact tag name to a reproduction the charter admits it cannot see. |
| improved:builtin | ## Goal<br>A component that the template reaches through a props path (`props.xxx`-style, as in the reproduction) should render as its real markup. Today the output is the literal tag `<info.icon></info.icon>`. Expected output is `<div>hello</div>`. The ticket does not show the template syntax, the props shape, or whether the failure happens in server or client rendering, because the reproduction links are encoded and their contents are not readable from the ticket.<br><br>## Scenarios<br>- Given the reproduction setup in which a template renders a component through a props member path, when the page renders, then the output contains `<div>hello</div>` and does not contain the literal text `<info.icon></info.icon>`.<br>- Given the same setup, when the render output is captured as a string, then the string equals `<div>hello</div>`.<br>- Given the reproduction link is opened and run, when the rendered result is viewed, then "hello" appears inside a `div` and no literal `info.icon` tag text is shown. | resolve namespaced component from props bindings (non-inline): **partial** (s1) — Issue states expected output `<div>hello</div>` instead of literal `<info.icon></info.icon>`. Scenario 1 covers that outcome at render level. Test checks compiler output: namespaced tag resolved via `$props[...]` with no RESOLVE_COMPONENT in non-inline mode. Charter never mentions compile-mode or compiler-level resolution.<br>resolve namespaced component from props bindings (inline): **partial** (s1) — Same behaviour as the non-inline case, in inline mode with `__props[...]`. Scenario 1 covers the render result, not inline compilation or the resolution path. | s3: Depends on opening the playground link, which the ticket cannot show. Charter itself admits link contents are unreadable. Not a testable outcome beyond scenarios 1 and 2. |

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
| raw | ## Goal<br>A user who renders a select text field with `disabled` finds the field's hidden `<input>` element marked `disabled` in the page markup, matching the disabled state the field already shows. Unknown from the ticket: which browser, Material-UI version, and React version are affected (the environment table is blank); whether `aria-disabled` on the root element must stay or be removed; and whether form submission behavior is a requirement or only motivation.<br><br>## Scenarios<br>- Given a `TextField` with `select` and `disabled` set, when the page is rendered and the field's `<input>` element is inspected, then the `<input>` element has the `disabled` attribute. | /home/material-ui/packages/material-ui/src/Select/Select.test.js:<Select /> accessibility sets disabled attribute in input when component is disabled: **covered** (s1) — Scenario states select+disabled TextField's input must have disabled attribute; matches the issue's expected behavior. | none |
| improved:builtin | ## Goal<br>A user who disables a `TextField` with `select` sees the disabled state on the hidden native `<input>` element, not only on the wrapping `div`. Inspecting the field shows the `<input>` as disabled, and a disabled select field does not submit its value with the form.<br><br>## Scenarios<br>- Given a `TextField` with `select` and `disabled` is rendered, when the user inspects the field in the browser's element inspector, then the `<input>` element has the `disabled` attribute.<br>- Given a `TextField` with `select` and `disabled` is rendered inside a form, when the user submits the form, then the select's value is not included in the submitted form data. | /home/material-ui/packages/material-ui/src/Select/Select.test.js:<Select /> accessibility sets disabled attribute in input when component is disabled: **covered** (s1) — Scenario 1 states the <input> element has the disabled attribute when select TextField is disabled, which is exactly what the test checks. | s2: Issue only mentions in Context that disabled fields are not submitted as motivation; the expected form submission behaviour is not a stated expected outcome, and charter invents a form-submit scenario beyond the Expected Behavior (input has disabled prop). |

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
| raw | ## Goal<br>A user clicks a Switch whose click handler calls `preventDefault`. The Switch must keep its current on or off position and must not flip. The ticket reports that it still flips in Material-UI v4.11.0 with React v16.14.0. The ticket does not say whether keyboard toggling or label clicks are affected, whether the expected behavior also applies to controlled Switches, or what visible change counts as "updating".<br><br>## Scenarios<br>- Given a Switch in the off position in Material-UI v4.11.0 with React v16.14.0, whose `onClick` calls `preventDefault`, when the user clicks the Switch, then it stays in the off position.<br>- Given a Switch in the on position, whose `onClick` calls `preventDefault`, when the user clicks the Switch, then it stays in the on position.<br>- Given a Switch in the off position with no `onClick` handler, when the user clicks the Switch, then it moves to the on position. | /home/material-ui/packages/material-ui/src/internal/SwitchBase.test.js:<SwitchBase /> handleInputChange() should not change checkbox state when event is default prevented: **covered** (s1) — Issue states preventDefault in onClick must stop Switch from updating; scenarios 1 and 2 check Switch stays in its position after click with preventDefault. | none |
| improved:builtin | ## Goal<br>When a Switch's `onClick` handler calls `preventDefault` on the click event, clicking the Switch must leave its on/off position unchanged. The ticket reports the opposite: the Switch still flips. It was reported on Material-UI v4.11.0 with React v16.14.0. The ticket does not say whether the Switch is controlled or uncontrolled, what its starting state is, or which browser was used.<br><br>## Scenarios<br>- Given a Switch whose `onClick` handler calls `preventDefault` on the click event, when the user clicks the Switch, then the Switch stays in the on/off position it had before the click. | /home/material-ui/packages/material-ui/src/internal/SwitchBase.test.js:<SwitchBase /> handleInputChange() should not change checkbox state when event is default prevented: **covered** (s1) — Scenario states that when onClick calls preventDefault, Switch keeps its prior on/off position after click. This matches the test's check that checkbox state does not change when the event is default prevented. | none |

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
| raw | ## Goal<br>Custom theme CSS that contains a base64 image with `==` padding no longer breaks Dark Reader. Pages with Dark Reader enabled render with correct styling, and the extension can still be turned off and on without failing. Unknown from ticket: behavior when the padded CSS targets an open tab, whether padding with one `=` also breaks, and whether Opera or other browsers behave the same as Chrome.<br><br>## Scenarios<br>- Given Dark Reader enabled and a theme containing a dummy site entry with a `data:image/png;base64,...==` value in CSS, when a tab for a site with Dark Reader enabled is refreshed, then the page shows normal styling with no broken CSS.<br>- Given the same theme is active, when the extension is turned off and on repeatedly, then the extension still toggles on and off and still applies Dark Reader to pages.<br>- Given the same theme is active, when the extension's background inspect view is opened, then no `Uncaught (in promise) SyntaxError: Invalid regular expression` error appears.<br>- Given the theme's dummy entry names a host with no open tab, when the theme is saved and a non-matching page is open, then the padded CSS is ignored and no styling changes on that page.<br>- Given the theme contains only a base64 value without `==` padding, when a Dark Reader-enabled tab is refreshed, then the page renders normally (baseline for comparison; ticket does not state this behavior). | tests/generators/utils/parse.tests.ts:Base64 in CSS: **partial** (s3) — Test checks parser splits blocks correctly and keeps the padded base64 CSS intact, with no stray ') !important;' domain pattern. Scenarios 1 and 3 touch on no breakage or no regex error, but none states that the parser must not treat `==` inside CSS as a block delimiter or that the CSS stays whole in the right block.<br>tests/generators/utils/parse.tests.ts: **partial** (s3) — Same hunk as 'Base64 in CSS'. The charter covers the symptoms (no regex error, no broken CSS) but not the parsing behavior the test asserts: correct splitting of blocks and the CSS preserved verbatim under the right URL. | s5: The charter itself says the ticket does not state the one-'=' or no-padding behavior. Issue only concerns '==' padding, so this expected outcome is invented.<br>s4: Issue says padded CSS should be ignored when no open tab matches. But 'theme is saved' and 'no styling changes on that page' add specifics the issue does not state. |
| improved:builtin | ## Goal<br>A theme whose CSS contains a base64 data URI padded with `==` no longer breaks Dark Reader. Pages load, the theme applies, the on/off toggle works, and the background inspect view shows no uncaught error. The ticket does not say exactly what the "broken CSS" looks like on the page. It also covers only the case where no open tab matches the theme's entry, so the outcome when a tab does match is unknown. The ticket does not say whether the `IGNORE INLINE STYLE` line changes the outcome.<br><br>## Scenarios<br>- Given a theme containing a dummy site entry whose CSS has `url('data:image/png;base64,...==')`, when the user refreshes a tab on a site with Dark Reader enabled, then the page shows no broken CSS and Dark Reader runs normally.<br>- Given the same theme, when the user opens the extension's background inspect view and refreshes a tab, then no `Uncaught (in promise) SyntaxError: Invalid regular expression` error appears.<br>- Given the same theme, when the user turns the extension off and on repeatedly, then each toggle takes effect and the extension keeps working.<br>- Given a theme with a rule such as `.CodeMirror-merge-r-deleted` whose `background-image` holds a `==`-padded base64 URL, when the user loads any tab, then the page is unaffected and no error appears.<br>- Given the theme with the `IGNORE INLINE STYLE` line present, and again with it absent, when the user refreshes a tab, then the outcome is the same: no broken CSS and no error. | tests/generators/utils/parse.tests.ts:Base64 in CSS: **partial** (s4) — Scenario 4 uses the CodeMirror rule with a ==-padded base64 URL, but it checks only that the page is unaffected and there is no error. It never says the parser keeps the block's CSS intact, or that blocks are split correctly, with the '*' block and the example.com block kept separate.<br>tests/generators/utils/parse.tests.ts: **partial** (s4) — This is the same Base64 in CSS test. The charter covers the symptoms (no error, no broken CSS) but not the issue's root cause, which is that a ==-padded base64 string inside CSS must not be treated as a block delimiter. The parsed fixes output is also not stated. | s5: The issue says only that the IGNORE INLINE STYLE line 'isn't required sometimes'. It never says the outcome is the same with or without it. |

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
| raw | ## Goal<br>A user with Dark Reader's Dynamic Theme on, in Firefox Nightly 93.0a1, opens the reported Unix & Linux Stack Exchange question and sees the site fixes applied, where before none were found. The ticket does not name which fix(es) apply to this page, what the fixed page should look like, whether other sites are affected, or whether #6738 must be in place for this to hold.<br><br>## Scenarios<br>- Given Dark Reader with Dynamic Theme enabled in Firefox Nightly 93.0a1, when the user opens https://unix.stackexchange.com/questions/405783/why-does-man-print-gimme-gimme-gimme-at-0030, then the site fixes for that page are applied. | tests/generators/utils/parse.tests.ts:Index config: **missing** — Test checks generic '*' fix ordered first in results. Issue says last-entry check is wrong and should be fixes[0] is '*', implying generic first. Charter has no scenario on ordering.<br>tests/generators/utils/parse.tests.ts:Domain appearing multiple times within the same record: **missing** — Checks '*' fix first in returned fixes. Issue implies this ordering; charter only says fixes applied on one page.<br>tests/generators/utils/parse.tests.ts: **missing** — Hunk reorders expected fixes so '*' generic comes first and adds a generic-first test. Issue implies generic fix at index 0; charter does not state it.<br>tests/generators/utils/parse.tests.ts:The generic fix appears first: **missing** — Directly checks generic '*' fix is first. Issue implies fixes[0].url[0] === '*' expected; charter scenario only says page fixes get applied.<br>tests/generators/utils/parse.tests.ts:Domain appearing in multiple records: **missing** — Expects '*' fix first in list. Issue implies this ordering; no charter scenario covers it. | none |
| improved:builtin | ## Goal<br>On the reported page (unix.stackexchange question 405783), Dark Reader's dynamic theme should apply its site fixes in Firefox Nightly 93.0a1, where the report says they are not applied. The ticket does not name the fixes, the visible effect that shows a fix applied, the other sites meant by "the sites", the contents of the non-qualified domain list, or whether #6738 must be applied first for the symptom to appear.<br><br>## Scenarios<br>- Given Dark Reader with the dynamic theme on, in Firefox Nightly 93.0a1 on Arch Linux, when the user opens https://unix.stackexchange.com/questions/405783/why-does-man-print-gimme-gimme-gimme-at-0030, then the site fixes are applied and the page shows their effect. The ticket does not name that effect.<br>- Given the same setup, when the user opens the same page with a fix list whose last entry is a non-qualified domain, then the fixes are applied the same way as in the scenario above. The ticket does not say which domain is last.<br>- Given #6738 is not applied, when the user opens the same page, then the ticket does not say whether the fixes are applied. Confirm before testing this case. | tests/generators/utils/parse.tests.ts:Index config: **missing** — Test expects generic '*' fix ordered first, before domain-specific fix. Issue implies this (fixes[0].url[0] !== '*' check) but no scenario states generic fix order.<br>tests/generators/utils/parse.tests.ts:Domain appearing multiple times within the same record: **missing** — Expects '*' fix first in returned list. Issue implies this ordering; no scenario states it.<br>tests/generators/utils/parse.tests.ts: **missing** — Hunk reorders results so generic '*' fix comes first and adds a 'generic fix appears first' test. Issue's fixes[0] suggestion implies it; charter has no scenario on ordering.<br>tests/generators/utils/parse.tests.ts:The generic fix appears first: **missing** — Directly checks '*' fix is first in the list. Issue says check should be fixes[0].url[0] !== '*', implying '*' first; charter scenario 2 only says last entry is non-qualified domain, not that generic fix is first.<br>tests/generators/utils/parse.tests.ts:Domain appearing in multiple records: **missing** — Expects '*' fix first rather than last. Issue implies this; no scenario states the ordering. | s3: Asks whether fixes apply without #6738; issue gives no expected outcome, so scenario has no supported criterion. |

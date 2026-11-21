---
name: killing-mutants
description: Kill Stryker mutants (Survived, NoCoverage, equivalent) with tests. Use when a mutation gate (`gate:mutation`, `test:mutation:changed`, CI `Mutation score`) fails.
---

# Killing mutants

The gate decides the verdict and prints the mutants. Use this skill to kill them.

- For the `gate:mutation` verdict rules, read `@arch:GATE-MUTATION` in `docs/arch/stages-and-gates.md`.
- For the CI delta gate rules, read the header of `scripts/mutationGate.mjs`.

Write each test RED first. The test must fail on the mutated code. A mutant is killed when the next gate run reports it as `Killed`. A green test alone does not show this.

## Kill patterns by mutator

The useful facts are the exact replacements. Stryker writes them, and a test must see the difference.

| Mutator | What Stryker did | Test that kills it |
|---|---|---|
| `ConditionalExpression` | Replaced a condition with `true` or `false`. | Cover both branches. Assert a result that differs between them. |
| `StringLiteral` | Replaced a string with `""`, or an empty string with `"Stryker was here!"`. | Assert the exact text: the toast message, the CLI arg, the key. `toContain('x')` often lets it survive. |
| `BlockStatement` | Emptied a function or `if` body. | Assert the side effect of the body: a call on a fake, a store row, a returned value. |
| `MethodExpression` | Swapped a method, for example `startsWith` → `endsWith`, or removed `filter` or `trim`. | Use an input where the swap changes the output, for example padded text or an item that the filter must drop. |
| `OptionalChaining` | Changed `a?.b` to `a.b`. | Pass `undefined` or `null` for `a`. Assert no throw and the fallback value. |
| `LogicalOperator` | Changed `&&` to `\|\|`, `\|\|` to `&&`, and `??` to `&&`. | For `??`: pass a truthy left value and a different right value, and assert the left value. Or pass `null` and assert the right value. For `&&` and `\|\|`: use one truthy and one falsy operand. |
| `ObjectLiteral`, `ArrayDeclaration` | Replaced a non-empty object with `{}`, a non-empty array with `[]`, or `[]` with `["Stryker was here"]`. | Assert the full value with `toEqual`. |
| `EqualityOperator` | Changed `<` to `<=` or `>=`, or `===` to `!==`. | Test the boundary value exactly. |
| `BooleanLiteral` | Flipped `true` and `false`, or removed a `!`. | Assert the flag in the output or the call args. |
| `ArrowFunction` | Replaced an expression-body arrow with `() => undefined`. A block-body arrow gets `BlockStatement`. | Assert the value that the callback produces, for example an id from an injected generator. |
| `Regex` | Removed an anchor or a quantifier, negated a class or a lookaround. | Use an input that only the original pattern accepts or rejects: a match in the middle of the string for an anchor, `"aa"` for `a+`. |
| `ArithmeticOperator`, `AssignmentOperator`, `UpdateOperator`, `UnaryOperator` | Swapped `+` and `-`, `+=` and `-=`, `++` and `--`, `-x` and `+x`, or removed `~`. | Assert the exact number, with an input where the swap gives a different value. |

## NoCoverage

A `NoCoverage` mutant has no test in the mutation suite that runs its line. Find the cause first:

- **The test is outside the mutation suite.** The suite runs only the tests that the `include` of `vitest.mutation.config.ts` matches. For example, a test in `src/workflow/` that calls extension code does not count. Put the test next to the source file.
- **The branch is not reached.** Add a test input that reaches the line, often an error path or an empty input.

`gate:mutation` can also fail before any mutant runs, with `mutation: no test imports <files>`. The cause is the same as the first bullet: no test in the suite imports the listed files.

A **static** mutant (module-level code) shows as `Ignored`, not as NoCoverage, because `ignoreStatic` is on. Neither gate counts it.

## Equivalent mutants

An **equivalent** mutant changes the code but not the behavior, so no test can kill it. A common cause is a guard that exists only for the types. Restructure the code to remove the redundant branch. For example, narrow the type earlier.

To disable a mutant, write `// Stryker disable next-line <mutator>: <reason>`. Put the reason after the colon.

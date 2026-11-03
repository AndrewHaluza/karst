# Ship Title Type Prefix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship and the ship preview render `<type>: <title>` without doubling a conventional prefix that the ticket title already has.

**Architecture:** Add one pure helper, `splitConventionalTitle`, to `src/workflow/conventionContext.ts`. `resolveShipArtifacts` (`src/workflow/shipPreview.ts`) calls it before it builds the template context. Ship and the preview already share this function (@arch:SHIP-PREVIEW), so they stay identical.

**Tech Stack:** TypeScript (ESM), vitest.

**Spec:** the ticket description (CHORE-KARST-S-OWN-PR-TITLES-AND, decisions 1-3).

## Global Constraints

- ESM imports need the `.js` suffix. `noUncheckedIndexedAccess` is on.
- Strict TDD: RED, then GREEN. Conventional commits.
- Prefix regex: `^<type>(\(<scope>\))?!?:\s+`. `<type>` must pass `isTicketType` (`src/store/ticketTypes.ts`).
- The ticket stored type wins over the title prefix type. A null stored type takes the prefix type.
- A title without a known prefix stays unchanged.
- Do not add a template transform. Do not retitle adopted PRs.
- Run `npm run -s typecheck` after test edits. Run the full suite once at the end.

## Decisions on the unknowns

- `<default type>` is the existing `resolveTicketType` result: `conventions.defaultType`, else `feat`. No change.
- Known types are exactly `TICKET_TYPES`. The check is case-sensitive, as `isTicketType` is.
- The preview command is not needed: the preview calls `resolveShipArtifacts`.
- The text "Output EXACTLY this markdown" in the ticket is not part of the scope. Ignore it.

## File Structure

- Modify `src/workflow/conventionContext.ts`: add `splitConventionalTitle`.
- Modify `src/workflow/shipPreview.ts` (`resolveShipArtifacts`): use the helper.
- Modify `src/workflow/conventionContext.test.ts` and `src/workflow/shipPreview.test.ts`: tests.
- External, not tracked: `/Users/nd/Work/projects/karst/.karst/karst.yml` (Task 3).

---

### Task 1: `splitConventionalTitle` helper

**Files:**
- Modify: `src/workflow/conventionContext.ts`
- Test: `src/workflow/conventionContext.test.ts`

**Interfaces:**
- Consumes: `isTicketType(value: unknown): value is TicketType` and `TicketType` from `../store/ticketTypes.js`.
- Produces: `splitConventionalTitle(title: string): { type: TicketType | null; title: string }`.

- [ ] **Step 1: Write the failing test.** Add `splitConventionalTitle` to the existing import from `./conventionContext.js`, then append:

```ts
describe('splitConventionalTitle', () => {
  it.each([
    ['fix: Foo', 'fix', 'Foo'],
    ['feat(sbx): Foo', 'feat', 'Foo'],
    ['fix!: Foo', 'fix', 'Foo'],
    ['refactor(core)!: Foo bar', 'refactor', 'Foo bar'],
    ['fix:   Foo', 'fix', 'Foo'],
  ])('strips the known prefix of %s', (input, type, title) => {
    expect(splitConventionalTitle(input)).toEqual({ type, title });
  });

  it.each(['Foo', 'Ticket form: Foo', 'Fix: Foo', 'fix:Foo', 'fix: ', 'fixes: Foo'])(
    'leaves %j unchanged',
    (input) => {
      expect(splitConventionalTitle(input)).toEqual({ type: null, title: input });
    },
  );
});
```

- [ ] **Step 2: Run it and see it fail.**
Run: `npx vitest run src/workflow/conventionContext.test.ts`
Expected: FAIL, `splitConventionalTitle` is not a function.

- [ ] **Step 3: Implement.** In `conventionContext.ts` change the import to `import { DEFAULT_TICKET_TYPE, isTicketType, type TicketType } from '../store/ticketTypes.js';` and add:

```ts
/** `type(scope)!: ` at the start of a title. `\S` after the spaces keeps an empty rest unmatched. */
const CONVENTIONAL_PREFIX = /^([a-z]+)(?:\([^()\s]*\))?!?:\s+(?=\S)/;

/**
 * Split a known conventional prefix off a ticket title, so a `{type}: {title}`
 * template never renders `fix: fix: …`. Only a curated ticket type counts
 * (`Ticket form: Foo` is not a prefix). The scope and `!` are dropped.
 */
export function splitConventionalTitle(title: string): { type: TicketType | null; title: string } {
  const match = CONVENTIONAL_PREFIX.exec(title);
  const type = match?.[1];
  if (!match || !isTicketType(type)) return { type: null, title };
  return { type, title: title.slice(match[0].length) };
}
```

- [ ] **Step 4: Run it and see it pass.**
Run: `npx vitest run src/workflow/conventionContext.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/workflow/conventionContext.ts src/workflow/conventionContext.test.ts
git commit -m "feat: split a known conventional prefix off a ticket title"
```

---

### Task 2: Use the helper in `resolveShipArtifacts`

**Files:**
- Modify: `src/workflow/shipPreview.ts:172-201`
- Test: `src/workflow/shipPreview.test.ts`

**Interfaces:**
- Consumes: `splitConventionalTitle` (Task 1), `resolveTicketType(ticket, conventions)`.
- Produces: `ShipArtifacts.context.title` without the prefix. `commitMessage` and `prTitle` use it.

- [ ] **Step 1: Write the failing tests.** Append inside `describe('resolveShipArtifacts', …)`:

```ts
describe('conventional prefix in the ticket title', () => {
  const conventions = { commitMessage: '{type}: {title}', pullRequestTitle: '{type}: {title}' };
  const render = (title: string, type: string | null = null, defaultType?: string) =>
    resolveShipArtifacts({
      manifest: manifest({ extention: repo() }),
      ticketId: 7,
      key: 'T7',
      title,
      repoName: 'extention',
      ticket: { ...ticket, type },
      conventions: { ...conventions, ...(defaultType ? { defaultType } : {}) },
    });

  it('takes the type from the title when the ticket has none', () => {
    const a = render('fix: Foo');
    expect(a.prTitle).toBe('fix: Foo');
    expect(a.commitMessage).toBe('fix: Foo');
    expect(a.context.title).toBe('Foo');
  });

  it('lets the stored ticket type win', () => {
    expect(render('fix: Foo', 'feat').prTitle).toBe('feat: Foo');
  });

  it('uses the default type for a title with no prefix', () => {
    expect(render('Foo').prTitle).toBe('feat: Foo');
    expect(render('Foo', null, 'chore').prTitle).toBe('chore: Foo');
  });

  it('drops the scope of a scoped prefix', () => {
    expect(render('fix(sbx): Foo').prTitle).toBe('fix: Foo');
  });

  it('does not treat an unknown word as a prefix', () => {
    expect(render('Ticket form: Foo').prTitle).toBe('feat: Ticket form: Foo');
  });

  it('keeps the raw title when no convention is set', () => {
    const a = resolveShipArtifacts({
      manifest: manifest({ extention: repo() }),
      ticketId: 7, key: 'T7', title: 'fix: Foo', repoName: 'extention', ticket,
    });
    expect(a.prTitle).toBe('fix: Foo');
    expect(a.commitMessage).toBe('fix: Foo');
  });
});
```

- [ ] **Step 2: Run it and see it fail.**
Run: `npx vitest run src/workflow/shipPreview.test.ts`
Expected: FAIL (`fix: fix: Foo`, `feat: fix: Foo`).

- [ ] **Step 3: Implement.** In `shipPreview.ts` add `splitConventionalTitle` to the import from `./conventionContext.js`. In `resolveShipArtifacts`, after `conventions` is set, add:

```ts
  const split = splitConventionalTitle(input.title);
  const ticketType = resolveTicketType(
    { type: input.ticket.type ?? split.type },
    conventions,
  );
```

Then set `title: split.title,` and `type: ticketType,` in the context. Leave the `: input.title` fallbacks unchanged: with no template the raw title ships.

- [ ] **Step 4: Run it and see it pass.**
Run: `npx vitest run src/workflow/shipPreview.test.ts src/workflow/conventionContext.test.ts && npm run -s typecheck`
Expected: PASS.

- [ ] **Step 5: Check related tests and the mutation gate.**
Run: `npx vitest related src/workflow/shipPreview.ts src/workflow/conventionContext.ts`
Then: `npx stryker run --mutate src/workflow/conventionContext.ts,src/workflow/shipPreview.ts` and `node scripts/mutationSummary.mjs | tail -20`
Expected: tests pass, score >= 85. Add a test for any surviving mutant in the new code (for example the `!` and `\s+` branches).

- [ ] **Step 6: Update the docs block.** Run `grep -n "SHIP-PREVIEW" docs/arch/*.md`. Add one sentence to that block: the title loses a known conventional prefix before it renders. Then run `BASE_REF=develop PR_BODY= node scripts/docsGate.mjs` after the commit.

- [ ] **Step 7: Commit.**

```bash
git add src/workflow/shipPreview.ts src/workflow/shipPreview.test.ts docs/arch
git commit -m "feat: ship titles do not double a conventional type prefix"
```

---

### Task 3: Project conventions in `karst.yml`

**Files:**
- Modify: `/Users/nd/Work/projects/karst/.karst/karst.yml:185-186`. This file is outside the worktree and untracked. It does not ship with the branch.

- [ ] **Step 1: Edit the block** to:

```yaml
conventions:
  pullRequestTitle: '{type}: {title}'
  commitMessage: '{type}: {title}'
```

- [ ] **Step 2: Check that the manifest loads.**
Run: `node "$KARST_CLI" doctor --db "$KARST_DB" --manifest /Users/nd/Work/projects/karst/.karst/karst.yml`
Expected: no configuration error. Also run `npx vitest run src/manifest/load.test.ts`.

- [ ] **Step 3: Report.** State in the done report that `karst.yml` is outside git. The owner must apply or keep this edit by hand.

---

## Self-Review

- Decision 1: Task 3. Decision 2: Tasks 1 and 2. Decision 3: no separate change, shown by the shared helper.
- Scenarios: stored type none, stored `feat`, scoped, unknown prefix, no prefix: all in the Task 2 tests. Adopted PR rule: no code change, as ship never retitles an adopted PR. `karst doctor`: Task 3.
- Names match: `splitConventionalTitle` returns `{ type, title }` in both tasks.
- No placeholders found.

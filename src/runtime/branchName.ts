/**
 * The ticket worktree branch name: template vocabulary, validation, rendering.
 *
 * Separate from `artifactConventions` on purpose. A branch is created ONCE, is
 * checked out, and is what `gh pr create` pushes — a malformed value fails git
 * itself rather than merely looking wrong in a PR title. So this renderer
 * SANITIZES (git refs have a legal charset) where the artifact renderer only
 * validates, and it enforces one extra rule the artifacts don't need: the
 * template must vary per ticket, or two tickets would fight over one branch.
 *
 * `{repo}`/`{scope}` are deliberately absent from the vocabulary: two repository
 * entries sharing a `repoPath` resolve to ONE worktree (see `spin.ts`
 * `worktreeByRepo`), so a repo-dependent branch name has no single answer there.
 */

export const DEFAULT_BRANCH_TEMPLATE = 'karst/{type}/{slug}';

/** Variables a branch template may use. */
export const BRANCH_VARIABLES = ['type', 'slug', 'key', 'id', 'title'] as const;

/** At least one of these must appear, or every ticket renders the same branch. */
const UNIQUE_VARIABLES = ['slug', 'key', 'id'] as const;

export interface BranchTemplateContext {
  id: number;
  key: string | null;
  title: string | null;
  /** The ticket's rename-invariant worktree slug (`worktreeSlug`). */
  slug: string;
  /** Resolved conventional-commit type (`resolveTicketType`). */
  type: string;
}

const TOKEN = /\{([^{}]*)\}/g;
const MAX_LENGTH = 120;

/** Sanitize ONE substituted value: never introduces a `/`, never blank-checks. */
function sanitizeValue(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Sanitize the assembled ref: the template's own separators survive, everything
 * git forbids does not (`git check-ref-format`: no `..`, no `//`, no trailing
 * `/`, `.` or `.lock`, no control/special characters).
 */
function sanitizeRef(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9/_.-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/\/{2,}/g, '/')
    .replace(/-{2,}/g, '-')
    .replace(/^[/.\-_]+/, '')
    .replace(/[/.\-_]+$/, '')
    .slice(0, MAX_LENGTH)
    .replace(/[/.\-_]+$/, '');
  return cleaned.endsWith('.lock') ? cleaned.slice(0, -'.lock'.length).replace(/[/.\-_]+$/, '') : cleaned;
}

/**
 * Validate a branch template's syntax, vocabulary, and per-ticket uniqueness.
 * Runs at manifest load AND again at render, so a direct caller can't skip it.
 */
export function validateBranchTemplate(template: string): void {
  if (template.trim() === '') {
    throw new Error('branchName template must not be blank');
  }

  const allowed = new Set<string>(BRANCH_VARIABLES);
  const used = new Set<string>();
  let remainder = '';
  let lastIndex = 0;
  for (const match of template.matchAll(TOKEN)) {
    remainder += template.slice(lastIndex, match.index);
    const token = match[1]!;
    if (!allowed.has(token)) {
      throw new Error(`branchName contains unsupported variable "{${token}}"`);
    }
    used.add(token);
    lastIndex = match.index! + match[0].length;
  }
  remainder += template.slice(lastIndex);
  if (remainder.includes('{') || remainder.includes('}')) {
    throw new Error('branchName contains malformed template braces');
  }
  if (!UNIQUE_VARIABLES.some((v) => used.has(v))) {
    throw new Error(
      'branchName must include one of {slug}, {key} or {id} so two tickets cannot share a branch',
    );
  }
}

/**
 * Render `template` (or the default when absent/blank) into a legal branch name.
 * Values are sanitized before assembly and the whole ref again after, and an
 * all-sanitized-away result falls back to the ticket id — a branch name is never
 * allowed to come out blank.
 */
export function renderBranchName(
  template: string | undefined,
  context: BranchTemplateContext,
): string {
  const effective = template && template.trim() !== '' ? template : DEFAULT_BRANCH_TEMPLATE;
  validateBranchTemplate(effective);

  const values: Record<string, string> = {
    id: String(context.id),
    key: sanitizeValue(context.key ?? ''),
    title: sanitizeValue(context.title ?? ''),
    slug: sanitizeValue(context.slug),
    type: sanitizeValue(context.type),
  };
  const rendered = sanitizeRef(effective.replace(TOKEN, (_m, token: string) => values[token]!));
  return rendered || String(context.id);
}

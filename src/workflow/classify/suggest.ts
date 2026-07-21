import type { AgentAdapter } from '../../agent/adapter.js';

/**
 * The one AI touch in classification (§ onboarding): a one-shot, bounded call to
 * suggest signal words for an unclassified service. The user edits/approves the
 * result before it is written to the yml (or types signals manually). Runs once
 * per service — not per ticket.
 *
 * Parsing is defensive: the model may wrap the array in prose, so we extract the
 * first JSON array and normalize (lowercase/trim/dedupe). A result with no
 * parseable array yields `[]`, letting the caller fall back to manual entry. An
 * adapter rejection propagates so the caller can degrade gracefully.
 */

export interface SuggestInput {
  service: string;
  repoPath: string;
}

/**
 * Cap on suggested signals. A short, distinctive list classifies better than a
 * long one — extra generic words only cause false matches. The user prunes the
 * suggestion before saving, so this is a ceiling, not a target.
 */
const MAX_SIGNALS = 12;

/**
 * Generic engineering / tooling / test words that appear in almost every repo,
 * so they carry no service-distinguishing signal. Dropped from suggestions.
 */
const JUNK = new Set([
  'test', 'tests', 'testing', 'e2e', 'unit', 'integration', 'spec',
  'build', 'ci', 'cd', 'lint', 'lints', 'linter', 'format', 'prettier',
  'vitest', 'jest', 'cypress', 'playwright', 'mocha',
  'css', 'html', 'js', 'ts', 'tsx', 'jsx', 'code', 'config', 'setup',
  'app', 'repo', 'feature', 'bug', 'fix', 'refactor', 'chore', 'task',
]);

function buildPrompt(input: SuggestInput): string {
  return [
    `You classify tickets to code repositories.`,
    `For the repository "${input.service}" (path: ${input.repoPath}), output the`,
    `signal words that, appearing in a ticket's title, description, or tags,`,
    `mean the ticket touches THIS repository specifically.`,
    `Rules:`,
    `(1) at most ${MAX_SIGNALS} words;`,
    `(2) each is a SINGLE lowercase token — no spaces, no hyphens`,
    `(the classifier splits on non-alphanumerics, so multi-word terms never match);`,
    `(3) distinctive & domain-specific (framework, feature, or domain nouns like`,
    `"vue", "checkout", "invoice"), NOT generic engineering words`,
    `(exclude test, e2e, build, ci, lint, css, config, app, feature, fix);`,
    `(4) fewer high-signal words beat a long noisy list.`,
    `Respond with ONLY a JSON array of strings, e.g. ["checkout","invoice"].`,
  ].join(' ');
}

/** Extract the first JSON string-array from arbitrary text, or null. */
function extractArray(raw: string): string[] | null {
  const match = raw.match(/\[[^\][]*\]/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return null;
  }
}

/**
 * Normalize suggestions to what the deterministic scorer can actually match:
 * lowercase, trimmed, single alphanumeric tokens (the scorer tokenizes on
 * `[a-z0-9]+`, so anything with a space or hyphen is a dead signal), with junk
 * words removed, de-duplicated (stable order), and hard-capped.
 */
function normalize(words: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    const n = w.trim().toLowerCase();
    if (!/^[a-z0-9]+$/.test(n)) continue; // single token only (no space/hyphen)
    if (JUNK.has(n)) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= MAX_SIGNALS) break;
  }
  return out;
}

/**
 * Ask the agent to suggest signal words for a service. Returns a normalized list,
 * or `[]` when nothing parseable came back. Rejects only if the adapter itself
 * rejects (so the caller can offer manual entry).
 */
export async function suggestSignals(
  adapter: AgentAdapter,
  input: SuggestInput,
): Promise<string[]> {
  const result = await adapter.runHeadless({
    prompt: buildPrompt(input),
    cwd: input.repoPath,
  });
  const arr = extractArray(result.raw);
  return arr ? normalize(arr) : [];
}

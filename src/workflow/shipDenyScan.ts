/**
 * Ship stages the entire worktree — `prepareCommitInQuarantine` runs
 * `git add -A`, because a stage marker means the agent believes it is done, not
 * that it committed. So anything left behind becomes a commit, a push to origin,
 * and a public PR with no human in the loop. This module refuses the
 * recognizably secret-shaped ones. Both untracked entries (`??`) and
 * staged-but-uncommitted entries (`A`/`AM`/`AD`) are scanned, because
 * `prepareCommitInQuarantine` commits everything in the index. Committing a file
 * by hand (tracked, already in HEAD) is therefore the escape hatch — a tracked
 * file is never scanned.
 */

/** A deny-list match from an untracked or staged entry. */
export interface DenyHit {
  /** The worktree-relative path git reported, unquoted. */
  path: string;
  /** Stable rule id — part of the operator-facing message, so do not rename. */
  rule: 'dotenv' | 'private-key' | 'credentials-file' | 'sensitive-dir';
}

/** Maximum number of hits rendered in the failure message before truncation. */
export const SHIP_DENY_HIT_LIMIT = 10;

// ── Rule literal sets ────────────────────────────────────────────────────────

const DOTENV_TEMPLATE_EXEMPTIONS: readonly string[] = [
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.dist',
];

const PRIVATE_KEY_EXTENSIONS: readonly string[] = ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore'];

const PRIVATE_KEY_BASENAMES: readonly string[] = [
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
];

const CREDENTIAL_BASENAMES: readonly string[] = [
  'credentials',
  'credentials.json',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.dockercfg',
  'service-account.json',
  'secrets.json',
  'secrets.yaml',
  'secrets.yml',
];

const SENSITIVE_DIR_SEGMENTS: readonly string[] = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.docker',
  '.kube',
];

// ── Scanner ──────────────────────────────────────────────────────────────────

/**
 * Parse `git status --porcelain -uall` output and return deny-list hits for
 * **untracked** (`??`) and **staged-but-uncommitted** (`A`/`AM`/`AD`) entries.
 * Tracked modifications (`M`) are never scanned — a file the repository already
 * tracks in HEAD is already published.
 */
export function scanPorcelainForDenied(porcelain: string): DenyHit[] {
  const lines = porcelain.split('\n');
  const hits: DenyHit[] = [];

  for (const line of lines) {
    // Untracked (`?? path`) or staged-but-uncommitted (`A  path`, `AM path`,
    // `AD path`). The index character is `A` and the second character is a
    // space or a letter; this matches exactly the statuses whose files end up in
    // the commit `prepareCommitInQuarantine` creates.
    const isUntracked = line.startsWith('?? ');
    const isStaged = line.length >= 2 && line[0] === 'A' && (line[1] === ' ' || line[1] === 'M' || line[1] === 'D');
    if (!isUntracked && !isStaged) continue;

    let path = line.slice(3);
    if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) {
      path = path.slice(1, -1);
    }
    if (path === '') continue;

    const segments = path.split('/');
    const base = segments[segments.length - 1] ?? '';
    const lower = base.toLowerCase();

    // Rule 1 — dotenv
    if (lower === '.env' || lower.startsWith('.env.')) {
      if (!DOTENV_TEMPLATE_EXEMPTIONS.includes(lower)) {
        hits.push({ path, rule: 'dotenv' });
        continue;
      }
    }

    // Rule 2 — private-key
    if (
      PRIVATE_KEY_EXTENSIONS.some((ext) => lower.endsWith(ext)) ||
      PRIVATE_KEY_BASENAMES.includes(lower)
    ) {
      hits.push({ path, rule: 'private-key' });
      continue;
    }

    // Rule 3 — credentials-file
    if (CREDENTIAL_BASENAMES.includes(lower)) {
      hits.push({ path, rule: 'credentials-file' });
      continue;
    }

    // Rule 4 — sensitive-dir (any ancestor directory segment)
    const ancestorSegments = segments.slice(0, -1);
    if (ancestorSegments.some((s) => SENSITIVE_DIR_SEGMENTS.includes(s.toLowerCase()))) {
      hits.push({ path, rule: 'sensitive-dir' });
      continue;
    }
  }

  return hits;
}

// ── Failure message renderer ─────────────────────────────────────────────────

/**
 * Render the operator-facing failure message for deny-list hits.
 * Returns the empty string when `hits` is empty (the caller never does this;
 * the behavior is defined so the function is total).
 */
export function describeDenyHits(hits: DenyHit[], repo: string): string {
  if (hits.length === 0) return '';

  const listed = hits.slice(0, SHIP_DENY_HIT_LIMIT);
  const parts = listed.map((h) => `${h.path} (${h.rule})`);
  let list = parts.join(', ');
  if (hits.length > SHIP_DENY_HIT_LIMIT) {
    list += `, +${hits.length - SHIP_DENY_HIT_LIMIT} more`;
  }

  return (
    `refusing to commit in ${repo}: ${hits.length} untracked or staged file(s) match ship's ` +
    `deny list — ${list}. Commit them deliberately (a tracked file is never ` +
    `scanned) or exclude them via .gitignore, then retry ship.`
  );
}

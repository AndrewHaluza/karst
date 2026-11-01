import type { Store } from './db.js';
import { BULLETIN_BODY_MAX, BULLETIN_TITLE_MAX } from './bulletinNotes.js';

/** `scripts/vitestGate.mjs` prints this line when a gate failure also fails at the merge base. */
const ALERT_RE = /^KARST-ALERT: develop-red base=([0-9a-f]{40}) tests=(.+)$/m;

/**
 * Gate output is untrusted (any test can print this line), so the alert is only
 * accepted in the exact shape vitestGate.mjs emits: a full 40-hex sha and test ids
 * shaped `<test file> > <name>`, bounded in count and length, control characters dropped.
 */
const TEST_ID_RE = /^(?:\|[^|]*\|\s*)?[\w./@+-]+\.[cm]?[jt]sx?(?: > [^\n]+)+$/;
const MAX_ALERT_TESTS = 20;
const MAX_TEST_ID_LEN = 300;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

export interface DevelopRedAlert {
  sha: string;
  tests: string[];
}

/** The develop-red alert a gate's output carries, or null. */
export function parseDevelopRedAlert(output: string): DevelopRedAlert | null {
  const m = ALERT_RE.exec(output.replace(/\r/g, ''));
  if (!m) return null;
  const tests = m[2]!
    .split('; ')
    .map((t) => t.replace(CONTROL_CHARS, '').trim().slice(0, MAX_TEST_ID_LEN))
    .filter((t) => TEST_ID_RE.test(t))
    .slice(0, MAX_ALERT_TESTS);
  return tests.length === 0 ? null : { sha: m[1]!, tests };
}

/**
 * Raise the project-level alert for a develop-red gate output: ONE host bulletin
 * note per (project, base sha), however many tickets hit it. No-op when the
 * output carries no alert or the sha was already alerted. True when a note was written.
 */
export function raiseDevelopRedAlert(store: Store, ticketId: number, output: string): boolean {
  const alert = parseDevelopRedAlert(output);
  if (alert === null) return false;
  const ticket = store.db.prepare('SELECT project_id FROM tickets WHERE id = ?').get(ticketId) as
    | { project_id: number | null }
    | undefined;
  if (!ticket) return false;
  const seen = store.db
    .prepare(
      `SELECT 1 FROM bulletin_notes WHERE source = 'host' AND merge_sha = ? AND title LIKE 'develop is red%' AND project_id IS ?`,
    )
    .get(alert.sha, ticket.project_id);
  if (seen) return false;
  const title = `develop is red at ${alert.sha.slice(0, 12)}`.slice(0, BULLETIN_TITLE_MAX);
  const body = `Tests failing on the merge base ${alert.sha}, not caused by any ticket:\n${alert.tests.map((t) => `- ${t}`).join('\n')}`;
  store.db
    .prepare(
      `INSERT OR IGNORE INTO bulletin_notes (project_id, source, from_ticket_id, merge_sha, title, body, repos, paths)
       VALUES (?, 'host', ?, ?, ?, ?, '[]', NULL)`,
    )
    .run(ticket.project_id, ticketId, alert.sha, title, body.slice(0, BULLETIN_BODY_MAX));
  return true;
}

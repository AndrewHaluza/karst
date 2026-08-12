import type { Store } from '../../store/db.js';
import { nowIso } from '../../model/time.js';
import { parseFlags, requireFlag, requireIntFlag, type TestFlags } from './flags.js';

/**
 * `karst test open-pr` — insert a PR row directly, so a test can stage the
 * "PRs are open" state a ship would have produced without touching GitHub.
 *
 * The `prs` table keys on (ticket, repo, url); a URL is required for every
 * consumer (`CURRENT_PR_ORDER`, the merge gate, the sync sweeps), so the driver
 * derives a synthetic one from the repo and number when the caller does not
 * supply `--url`. The URL is never fetched by anything — it is an identity and
 * a display string — so `karst://test/…` is honest about what it is.
 */

export interface ParsedOpenPr {
  repo: string;
  number: number;
  url: string;
  status: string;
  head: string | null;
  base: string | null;
}

export function parseOpenPrArgs(argv: string[]): ParsedOpenPr {
  const flags: TestFlags = parseFlags(argv);
  const repo = requireFlag(flags, 'repo');
  const number = requireIntFlag(flags, 'number');
  return {
    repo,
    number,
    url: flags.url ?? `karst://test/${repo}/pull/${number}`,
    status: flags.status ?? 'open',
    head: flags.head ?? null,
    base: flags.base ?? null,
  };
}

export function runOpenPr(store: Store, ticketId: number, parsed: ParsedOpenPr): string {
  store.db
    .prepare(
      `INSERT INTO prs (ticket_id, repo, number, url, status, head_ref, base_ref, created_at, merged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      ticketId,
      parsed.repo,
      parsed.number,
      parsed.url,
      parsed.status,
      parsed.head,
      parsed.base,
      nowIso(),
    );
  return JSON.stringify({
    repo: parsed.repo,
    number: parsed.number,
    url: parsed.url,
    status: parsed.status,
  });
}

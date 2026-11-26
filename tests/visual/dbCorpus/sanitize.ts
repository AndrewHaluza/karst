/**
 * Deterministic sanitizer for a Karst state corpus exported out of a real (or
 * seeded) SQLite database (T1365).
 *
 * A state built by `buildDashboardState` / `buildSidebarState` /
 * `buildUsageState` carries whatever the database held: absolute repo and
 * worktree paths, the user's home directory, PR URLs, ticket ids, log paths,
 * email addresses and (occasionally) a token an agent echoed into evidence.
 * None of that may reach a checked-in fixture.
 *
 * Three properties matter and each one is a rule here:
 *
 * - **Deterministic.** Two exports of the same database produce byte-identical
 *   output. Every mapping is assigned from a sorted set of the values found, so
 *   it never depends on traversal order, wall-clock time or `Math.random`.
 * - **Conservative.** A value is replaced only when a shape matches; an
 *   unrecognized string is left alone, and the final leak scan fails the export
 *   rather than shipping something the rules did not cover.
 * - **Idempotent over fixture values.** A value that is already a fixture
 *   value (`/fixture/...`, `fixture:...`, `fixture-token-redacted`) is passed
 *   through untouched, so sanitizing a generated fixture again changes nothing.
 *
 * The sanitizer walks JSON-shaped data (what the webviews are seeded with), not
 * a live `Store`, and it never mutates its input.
 */

/** The lowest id in the fixture ticket range (diffs already reserves 900001–999999). */
export const FIXTURE_TICKET_ID_MIN = 900001;
/** The highest id in the fixture ticket range. */
export const FIXTURE_TICKET_ID_MAX = 999999;

/** The prefix every sanitized filesystem path starts with. */
export const FIXTURE_PATH_PREFIX = '/fixture/';
/** The only email domain a sanitized corpus may contain. */
export const FIXTURE_EMAIL_DOMAIN = 'fixture.invalid';
/** What a redacted secret becomes. Obvious placeholder, never token-shaped. */
export const FIXTURE_REDACTED_TOKEN = 'fixture-token-redacted';
/** The scheme a sanitized URL becomes. */
export const FIXTURE_URL_PREFIX = 'fixture:url/';

/**
 * The instant a fixture's timestamps are anchored to. Imported from the
 * dashboard fixtures so the sweep's pinned clock and the corpus agree; the
 * exporter rebuilds every timestamp relative to it.
 */
import { FIXTURE_NOW_MS } from '../../../src/ui/dashboard/renderFixtures.js';

export { FIXTURE_NOW_MS };

/**
 * An absolute POSIX path: at least two `/segment` pairs, preceded by the start
 * of the string or a delimiter that cannot be part of a path segment. Two
 * segments is what separates `/Users/nd` (a path) from `/dashboard` (a route or
 * a word), and the `(?!\/)` guard keeps `https://…` out of the match — the URL
 * rule consumes those first anyway.
 */
const ABS_PATH = /(^|[\s"'([=,:;])((?:\/(?!\/)[A-Za-z0-9._@+%~-]+){2,})/g;
/**
 * A relative path that climbs out of the project root (`../../Users/nd/repo`).
 * `repoDisplayPath` renders every repo outside the fixture project root this
 * way, so on a real database it carries the operator's home directory without
 * a leading `/`. A `./`-led path stays below the fixture root and is left alone.
 */
const REL_PATH = /(^|[\s"'([=,:;])((?:\.\.\/)+[A-Za-z0-9._@+%~-]+(?:\/[A-Za-z0-9._@+%~-]+)*)/g;
/** A Windows absolute path (`C:\Users\…`). */
const WIN_PATH = /(^|[\s"'(=])([A-Za-z]:\\[^\s"']+)/g;
/** An http(s) URL, up to the first delimiter. */
const URL_RE = /\bhttps?:\/\/[^\s"'<>)\]}]+/g;
/** An email address. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
/** An ISO-8601 UTC instant, the timestamp format the karst state builders write. */
const ISO_UTC = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z\b/g;
/**
 * A SQLite `datetime('now')` value (`2026-01-02 03:04:05`, UTC, no zone mark).
 * Several store columns default to it, so it is rebased like an ISO instant.
 */
const SQLITE_UTC = /\b(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d{1,3})?\b/g;

/** The UTC instant of a SQLite datetime match, or NaN. */
function sqliteMs(date: string, time: string, frac: string | undefined): number {
  return Date.parse(`${date}T${time}${frac ?? ''}Z`);
}

/** Format an instant in the SQLite datetime form, with the fraction only when the source had one. */
function formatSqlite(ms: number, withFraction: boolean): string {
  const iso = new Date(ms).toISOString();
  return iso.slice(0, withFraction ? 23 : 19).replace('T', ' ');
}

/**
 * Secret shapes that must never survive: GitHub tokens, OpenAI-style keys,
 * Slack tokens, AWS access keys, JWTs, bearer headers and PEM private keys.
 */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** Properties whose numeric value is a ticket id and must move into the fixture range. */
const TICKET_ID_KEYS: ReadonlySet<string> = new Set([
  'ticketId',
  'parentTicketId',
  'subtaskParentId',
  'subtaskId',
  'childTicketId',
  'activeTicketId',
]);

/**
 * Properties holding an EXTERNAL ticket id (the ticketing provider's own id).
 * It names a record on someone's ClickUp board, so it becomes a `fixture:` ref.
 */
const EXTERNAL_REF_KEYS: ReadonlySet<string> = new Set(['sourceRef']);

/**
 * The shortest external ref the sanitizer replaces inside free text. A shorter
 * or digits-only ref (`42`, a GitHub issue number) would rewrite unrelated
 * words and numbers, so it is replaced only as a `sourceRef` value.
 */
const MIN_TEXT_REF_LENGTH = 4;

/** True when an external ref is distinctive enough to replace inside free text. */
function isTextReplaceableRef(ref: string): boolean {
  return ref.length >= MIN_TEXT_REF_LENGTH && /[A-Za-z]/.test(ref) && !/\s/.test(ref);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Properties whose string value is a person's login (`prs.author` from gh, a
 * review comment's author). Each distinct login becomes `fixture-user-<n>`.
 */
const USERNAME_KEYS: ReadonlySet<string> = new Set(['author', 'login', 'username']);
/** The prefix of every sanitized login; a value with it is already a fixture value. */
const FIXTURE_USER_PREFIX = 'fixture-';

function isPrivateUsername(key: string, value: unknown): value is string {
  return USERNAME_KEYS.has(key) && typeof value === 'string' && value !== '' && !value.startsWith(FIXTURE_USER_PREFIX);
}

/** A row's `id` is a ticket id when its sibling `idLabel` is that ticket's display form. */
function isLabelledTicketId(key: string, value: unknown, record: Record<string, unknown>): value is number {
  return key === 'id' && typeof value === 'number' && Number.isSafeInteger(value) && record['idLabel'] === `T${value}`;
}

/** `T<n>` in any string: the display form of a ticket id (`formatId('ticket', n)`). */
const TICKET_REF = /\bT(\d{1,9})\b/g;

export type LeakKind = 'path' | 'email' | 'url' | 'token' | 'username';

/** A login-bearing property in JSON text, for the leak scan. */
const USERNAME_JSON = /"(?:author|login|username)":"((?:[^"\\]|\\.)*)"/g;

/** One value the leak scan rejected. */
export interface Leak {
  kind: LeakKind;
  text: string;
}

export interface SanitizeOptions {
  /** The instant the fixture clock is pinned to; timestamps are rebased onto it. */
  nowMs?: number;
}

/** Rebase every ISO timestamp onto `nowMs`, keyed off the newest timestamp found. */
function timestampShift(instants: readonly number[], nowMs: number): number {
  if (instants.length === 0) return 0;
  const newest = instants.reduce((a, b) => (b > a ? b : a), instants[0]!);
  return nowMs - newest;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (value instanceof Date) return null;
  return value as Record<string, unknown>;
}

/** A URL match, with the sentence punctuation the regex over-captures trimmed off. */
function trimUrl(text: string): string {
  return text.replace(/[.,;]+$/, '');
}

function isTicketIdKey(key: string): boolean {
  return TICKET_ID_KEYS.has(key) || key.endsWith('TicketId');
}

/**
 * Collect the private values out of one tree, then rewrite them into a fixture
 * vocabulary. Both phases are separate because a stable mapping has to be
 * assigned from the WHOLE corpus (a path seen first in the dashboard and again
 * in the sidebar must map to the same fixture value).
 *
 * Use one instance for a multi-view export:
 *
 * ```ts
 * const s = new CorpusSanitizer();
 * for (const state of states) s.collect(state);
 * const clean = states.map((state) => s.apply(state));
 * ```
 */
export class CorpusSanitizer {
  private readonly nowMs: number;
  private readonly ticketIds = new Set<number>();
  private readonly paths = new Set<string>();
  private readonly urls = new Set<string>();
  private readonly refs = new Set<string>();
  private readonly instants = new Set<number>();
  private readonly users = new Set<string>();
  /** External refs and logins distinctive enough to replace in all text. */
  private readonly textRefs = new Set<string>();
  private textRefRe: RegExp | null = null;

  private ticketMap: Map<number, number> | null = null;
  private pathMap: Map<string, string> | null = null;
  private urlMap: Map<string, string> | null = null;
  private refMap: Map<string, string> | null = null;
  private userMap: Map<string, string> | null = null;
  private shift = 0;

  constructor(opts: SanitizeOptions = {}) {
    this.nowMs = opts.nowMs ?? FIXTURE_NOW_MS;
  }

  /** Register every private value in one state tree. Call before `apply`. */
  collect(value: unknown): void {
    const walk = (node: unknown): void => {
      if (typeof node === 'string') {
        this.collectString(node);
        return;
      }
      if (typeof node === 'number') return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (node instanceof Date) {
        if (Number.isFinite(node.getTime())) this.instants.add(node.getTime());
        return;
      }
      const record = asRecord(node);
      if (record === null) return;
      for (const [key, child] of Object.entries(record)) {
        if (typeof child === 'number' && isTicketIdKey(key) && Number.isSafeInteger(child)) {
          this.ticketIds.add(child);
        }
        if (isLabelledTicketId(key, child, record)) this.ticketIds.add(child);
        if (typeof child === 'string' && EXTERNAL_REF_KEYS.has(key) && child !== '') {
          this.refs.add(child);
        }
        if (isPrivateUsername(key, child)) {
          this.users.add(child);
          if (isTextReplaceableRef(child)) this.textRefs.add(child);
        }
        walk(child);
      }
    };
    walk(value);
    // Any collection invalidates the previously derived maps: a caller is free
    // to collect several trees before applying, but collection is a closed phase.
    this.invalidate();
  }

  private invalidate(): void {
    this.textRefRe = null;
    this.ticketMap = null;
    this.pathMap = null;
    this.urlMap = null;
    this.refMap = null;
    this.userMap = null;
    this.shift = 0;
  }

  /**
   * Register the provider ids the database holds (`tickets.source_ref` and
   * `source_ref_internal`). A provider-sourced ticket's `key` IS that id, and
   * descriptions and labels quote it, so no shape rule can tell it from a
   * word: the exporter names the values, and each one is replaced everywhere.
   */
  registerExternalRefs(refs: Iterable<string>): void {
    for (const ref of refs) {
      if (ref === '') continue;
      this.refs.add(ref);
      if (isTextReplaceableRef(ref)) this.textRefs.add(ref);
    }
    this.invalidate();
  }

  /** The registered external refs and collected logins that still appear in a tree, sorted. */
  leftoverRefs(value: unknown): string[] {
    this.freeze();
    const re = this.textRefRe;
    if (re === null) return [];
    const text = JSON.stringify(value) ?? '';
    const found = new Set<string>();
    for (const match of text.matchAll(re)) found.add(match[0]);
    return [...found].sort();
  }

  /** Return a sanitized deep copy of a collected tree. */
  apply<T>(value: unknown): T {
    this.freeze();
    return this.walk(value) as T;
  }

  /** The mappings this sanitizer resolved, for tests and for a leak-scan report. */
  mapping(): {
    ticketIds: ReadonlyMap<number, number>;
    paths: ReadonlyMap<string, string>;
    urls: ReadonlyMap<string, string>;
    refs: ReadonlyMap<string, string>;
    timestampShiftMs: number;
  } {
    this.freeze();
    return {
      ticketIds: this.ticketMap!,
      paths: this.pathMap!,
      urls: this.urlMap!,
      refs: this.refMap!,
      timestampShiftMs: this.shift,
    };
  }

  /** Assign the stable maps once, from the sorted sets collected so far. */
  private freeze(): void {
    if (this.ticketMap && this.pathMap && this.urlMap && this.refMap && this.userMap) return;
    const ticketIds = [...this.ticketIds].sort((a, b) => a - b);
    this.ticketMap = new Map(
      ticketIds.map((id, i) => [id, FIXTURE_TICKET_ID_MIN + i] as const),
    );
    const paths = [...this.paths].sort();
    this.pathMap = new Map(paths.map((p, i) => [p, `${FIXTURE_PATH_PREFIX}path/${i + 1}`] as const));
    const urls = [...this.urls].sort();
    this.urlMap = new Map(urls.map((u, i) => [u, `${FIXTURE_URL_PREFIX}${i + 1}`] as const));
    const refs = [...this.refs].sort();
    this.refMap = new Map(refs.map((r, i) => [r, `fixture:ref/${i + 1}`] as const));
    const users = [...this.users].sort();
    this.userMap = new Map(users.map((u, i) => [u, `${FIXTURE_USER_PREFIX}user-${i + 1}`] as const));
    // Longest first, so a ref that contains another one wins the match.
    const textRefs = [...this.textRefs].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
    this.textRefRe =
      textRefs.length === 0
        ? null
        : new RegExp(`(?<![A-Za-z0-9_-])(?:${textRefs.map(escapeRegExp).join('|')})(?![A-Za-z0-9_-])`, 'g');
    this.shift = timestampShift([...this.instants], this.nowMs);
  }

  private collectString(text: string): void {
    for (const match of text.matchAll(REL_PATH)) this.paths.add(match[2]!);
    for (const match of text.matchAll(ABS_PATH)) {
      const path = match[2]!;
      if (!path.startsWith(FIXTURE_PATH_PREFIX)) this.paths.add(path);
    }
    for (const match of text.matchAll(WIN_PATH)) this.paths.add(match[2]!);
    for (const match of text.matchAll(URL_RE)) this.urls.add(trimUrl(match[0]));
    for (const match of text.matchAll(ISO_UTC)) {
      const ms = Date.parse(match[0]);
      if (Number.isFinite(ms)) this.instants.add(ms);
    }
    for (const match of text.matchAll(SQLITE_UTC)) {
      const ms = sqliteMs(match[1]!, match[2]!, match[3]);
      if (Number.isFinite(ms)) this.instants.add(ms);
    }
    for (const match of text.matchAll(TICKET_REF)) {
      const id = Number(match[1]);
      if (Number.isSafeInteger(id)) this.ticketIds.add(id);
    }
  }

  private ticketFor(id: number): number {
    const map = this.ticketMap!;
    const hit = map.get(id);
    if (hit !== undefined) return hit;
    // A ticket id that surfaced only inside a string: allocate the next free
    // fixture id deterministically (traversal order, not randomness).
    const next = FIXTURE_TICKET_ID_MIN + map.size;
    if (next > FIXTURE_TICKET_ID_MAX) {
      throw new Error(`sanitize: more than ${FIXTURE_TICKET_ID_MAX - FIXTURE_TICKET_ID_MIN + 1} tickets`);
    }
    map.set(id, next);
    return next;
  }

  private pathFor(path: string): string {
    const map = this.pathMap!;
    const hit = map.get(path);
    if (hit !== undefined) return hit;
    const next = `${FIXTURE_PATH_PREFIX}path/${map.size + 1}`;
    map.set(path, next);
    return next;
  }

  private urlFor(url: string): string {
    const map = this.urlMap!;
    const hit = map.get(url);
    if (hit !== undefined) return hit;
    const next = `${FIXTURE_URL_PREFIX}${map.size + 1}`;
    map.set(url, next);
    return next;
  }

  private refFor(ref: string): string {
    const map = this.refMap!;
    const hit = map.get(ref);
    if (hit !== undefined) return hit;
    const next = `fixture:ref/${map.size + 1}`;
    map.set(ref, next);
    return next;
  }

  private userFor(user: string): string {
    const map = this.userMap!;
    const hit = map.get(user);
    if (hit !== undefined) return hit;
    const next = `${FIXTURE_USER_PREFIX}user-${map.size + 1}`;
    map.set(user, next);
    return next;
  }

  /** A text match of the ref/login regex: a provider id wins over a login of the same spelling. */
  private textRefFor(match: string): string {
    if (this.refMap!.has(match) || !this.userMap!.has(match)) return this.refFor(match);
    return this.userFor(match);
  }

  private sanitizeString(text: string): string {
    let out = text;
    // URLs first: their path portion must never be treated as a filesystem path.
    out = out.replace(URL_RE, (match) => {
      const url = trimUrl(match);
      return this.urlFor(url) + match.slice(url.length);
    });
    if (this.textRefRe !== null) out = out.replace(this.textRefRe, (match) => this.textRefFor(match));
    // Relative paths before absolute ones: `../../Users/nd` holds `/Users/nd`.
    out = out.replace(REL_PATH, (match, lead: string, path: string) => lead + this.pathFor(path));
    out = out.replace(ABS_PATH, (match, lead: string, path: string) =>
      lead + (path.startsWith(FIXTURE_PATH_PREFIX) ? path : this.pathFor(path)),
    );
    out = out.replace(WIN_PATH, (match, lead: string, path: string) => lead + this.pathFor(path));
    out = out.replace(EMAIL, (match) =>
      match.toLowerCase().endsWith(`@${FIXTURE_EMAIL_DOMAIN}`) ? match : `developer@${FIXTURE_EMAIL_DOMAIN}`,
    );
    for (const pattern of TOKEN_PATTERNS) {
      out = out.replace(pattern, (match) =>
        match === FIXTURE_REDACTED_TOKEN ? match : FIXTURE_REDACTED_TOKEN,
      );
    }
    out = out.replace(ISO_UTC, (match) => {
      const ms = Date.parse(match);
      if (!Number.isFinite(ms)) return match;
      return new Date(ms + this.shift).toISOString();
    });
    out = out.replace(SQLITE_UTC, (match, date: string, time: string, frac: string | undefined) => {
      const ms = sqliteMs(date, time, frac);
      if (!Number.isFinite(ms)) return match;
      return formatSqlite(ms + this.shift, frac !== undefined);
    });
    out = out.replace(TICKET_REF, (match, digits: string) => `T${this.ticketFor(Number(digits))}`);
    return out;
  }

  private walk(node: unknown): unknown {
    if (typeof node === 'string') return this.sanitizeString(node);
    if (typeof node !== 'object' || node === null) return node;
    if (node instanceof Date) return new Date(node.getTime() + this.shift);
    if (Array.isArray(node)) return node.map((item) => this.walk(item));
    const record = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) {
      // A record can be KEYED by private data too (`undelivered.byRepo` and the
      // per-repo env-override scopes are keyed by repo path).
      const outKey = this.sanitizeString(key);
      if (typeof child === 'number' && isTicketIdKey(key) && Number.isSafeInteger(child)) {
        out[outKey] = this.ticketFor(child);
        continue;
      }
      if (typeof child === 'string' && EXTERNAL_REF_KEYS.has(key) && child !== '') {
        out[outKey] = this.refFor(child);
        continue;
      }
      if (isLabelledTicketId(key, child, record)) {
        out[outKey] = this.ticketFor(child);
        continue;
      }
      if (isPrivateUsername(key, child)) {
        out[outKey] = this.userFor(child);
        continue;
      }
      out[outKey] = this.walk(child);
    }
    return out;
  }
}

/** Sanitize one tree on its own (collect + apply). */
export function sanitizeCorpus<T>(value: T, opts: SanitizeOptions = {}): T {
  const sanitizer = new CorpusSanitizer(opts);
  sanitizer.collect(value);
  return sanitizer.apply<T>(value);
}

/**
 * Every value in a tree that still looks like private data. The exporter runs
 * this on its own output and throws: a rule that missed a shape fails loudly
 * instead of committing the value.
 */
export function scanForLeaks(value: unknown): Leak[] {
  const text = JSON.stringify(value) ?? '';
  const leaks: Leak[] = [];
  const add = (kind: LeakKind, found: string): void => {
    if (!leaks.some((l) => l.kind === kind && l.text === found)) leaks.push({ kind, text: found });
  };

  for (const match of text.matchAll(REL_PATH)) add('path', match[2]!);
  for (const match of text.matchAll(ABS_PATH)) {
    const path = match[2]!;
    if (!path.startsWith(FIXTURE_PATH_PREFIX)) add('path', path);
  }
  for (const match of text.matchAll(WIN_PATH)) add('path', match[2]!);
  for (const match of text.matchAll(URL_RE)) add('url', trimUrl(match[0]));
  for (const match of text.matchAll(USERNAME_JSON)) {
    const user = JSON.parse(`"${match[1]!}"`) as string;
    if (user !== '' && !user.startsWith(FIXTURE_USER_PREFIX)) add('username', user);
  }
  for (const match of text.matchAll(EMAIL)) {
    if (!match[0].toLowerCase().endsWith(`@${FIXTURE_EMAIL_DOMAIN}`)) add('email', match[0]);
  }
  for (const pattern of TOKEN_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (match[0] !== FIXTURE_REDACTED_TOKEN) add('token', match[0]);
    }
  }
  return leaks;
}

/** Throw when a tree still carries private data; the error names what leaked. */
export function assertNoLeaks(value: unknown, label = 'corpus'): void {
  const leaks = scanForLeaks(value);
  if (leaks.length === 0) return;
  const shown = leaks
    .slice(0, 5)
    .map((l) => `  ${l.kind}: ${l.text}`)
    .join('\n');
  const more = leaks.length > 5 ? `\n  …and ${leaks.length - 5} more` : '';
  throw new Error(`${label}: sanitized output still carries private data:\n${shown}${more}`);
}

/**
 * The one canonical short id for the three numeric entities (docs/arch/ids.md).
 * Display-only: derived from the integer primary keys, no schema involved.
 * `#N` is reserved for GitHub PR numbers.
 */
export type EntityKind = 'ticket' | 'draft' | 'plan';

export const PREFIX: Readonly<Record<EntityKind, string>> = {
  ticket: 'T',
  draft: 'D',
  plan: 'P',
};

const NOUN: Readonly<Record<EntityKind, string>> = {
  ticket: 'ticket',
  draft: 'draft',
  plan: 'planning session',
};

const KIND_BY_PREFIX = new Map<string, EntityKind>(
  (Object.keys(PREFIX) as EntityKind[]).map((k) => [PREFIX[k], k]),
);

function assertId(n: number): void {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`id must be a positive integer, got ${n}`);
}

export function formatId(kind: EntityKind, n: number): string {
  assertId(n);
  return `${PREFIX[kind]}${n}`;
}

/** Separator between the id and the key in a ticket ref; `parseId` strips it and what follows. */
export const REF_SEPARATOR = ' · ';

/** `T583 · ABC-123`, or `T583` when the ticket has no (or a blank) provider key. */
export function formatTicketRef(id: number, key: string | null | undefined): string {
  const k = key?.trim();
  return k ? `${formatId('ticket', id)}${REF_SEPARATOR}${k}` : formatId('ticket', id);
}

const CANONICAL = /^[1-9][0-9]*$/;

export function parseId(text: string, expectedKind?: EntityKind): { kind: EntityKind; n: number } {
  const sep = text.indexOf(REF_SEPARATOR);
  const raw = (sep === -1 ? text : text.slice(0, sep)).trim();
  const want = expectedKind
    ? `expected a ${NOUN[expectedKind]} id (${PREFIX[expectedKind]}<n>)`
    : 'expected an id like T<n>, D<n> or P<n>';
  const fail = (): never => {
    throw new Error(`invalid id '${text}': ${want}`);
  };
  const prefixed = /^([A-Za-z])(.*)$/.exec(raw);
  if (prefixed) {
    const kind = KIND_BY_PREFIX.get(prefixed[1]!.toUpperCase());
    if (!kind || !CANONICAL.test(prefixed[2]!)) return fail();
    if (expectedKind && kind !== expectedKind) {
      throw new Error(`wrong id kind: ${want}, got '${raw}' (a ${NOUN[kind]} id)`);
    }
    return finish(kind, prefixed[2]!, fail);
  }
  if (!expectedKind) {
    throw new Error(`id '${text}' needs a prefix (${Object.values(PREFIX).join('/')}): ${want}`);
  }
  const digits = raw.startsWith('#') ? raw.slice(1) : raw;
  if (!CANONICAL.test(digits)) return fail();
  return finish(expectedKind, digits, fail);
}

function finish(kind: EntityKind, digits: string, fail: () => never): { kind: EntityKind; n: number } {
  const n = Number(digits);
  if (!Number.isSafeInteger(n)) return fail();
  return { kind, n };
}

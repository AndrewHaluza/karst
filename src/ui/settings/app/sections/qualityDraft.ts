/**
 * The Quality tab's write paths — the ONLY three that may write `draft.uat` or
 * `draft.review` (NDL-126 §8.3, D1/D3).
 *
 * The tab CLAIMS both blocks but renders only the keys with live consumers, so
 * every write here SPREADS the block as it stands and overrides just the patched
 * keys. Rebuilding either block from the rendered controls would silently erase
 * everything the tab does not show — and because `mergeSection` DELETES a field
 * the incoming manifest no longer carries, that erasure would reach the file.
 *
 * Concretely preserved:
 *
 * - `updateUat` deletes `testerObservations` when the patch omits it, which is
 *   how unchecking the toggle removes the block. That also fires for a patch that
 *   simply does not mention the key (`maxFixAttempts`, a gate list) — a quirk of
 *   the vanilla helper that is kept rather than "fixed", because a fix here would
 *   change what a Quality edit does to a manifest that declared the block.
 * - `updateFindings` deep-merges over `REVIEW_FINDINGS_DEFAULTS` FIRST, then over
 *   the current draft, so a partially specified `review.findings` — or an absent
 *   one — cannot lose a sibling key to an edit of just one findings field.
 */
import type { GateDef, Manifest, ReviewConfig, UatConfig } from '../../../../manifest/types.js';
import { REVIEW_FINDINGS_DEFAULTS } from '../../../../manifest/qualityDefaults.js';

/**
 * The draft's view of the two blocks.
 *
 * `Manifest` types `uat` / `review` as the VALIDATOR's output — fully defaulted,
 * every required key present — but the DRAFT is genuinely partial: the tab
 * creates `draft.uat = { testerObservations }` from nothing and lets Save let the
 * host fill the rest. So the two blocks are read here as partial, and that is the
 * ONLY cast boundary: everything above this file deals in `Manifest` again.
 */
type DraftUat = Partial<UatConfig>;
type DraftReview = Partial<Omit<ReviewConfig, 'findings'>> & {
  findings?: Partial<NonNullable<ReviewConfig['findings']>>;
};
type QualityBlocks = { uat?: DraftUat; review?: DraftReview };

export type Base = 'uat' | 'review';

type UatPatch = Partial<Omit<UatConfig, 'testerObservations'>> & {
  testerObservations?: UatConfig['testerObservations'];
};
type ReviewPatch = Partial<Omit<ReviewConfig, 'findings'>> & {
  findings?: Partial<NonNullable<ReviewConfig['findings']>>;
};

/** `draft` as the tab's partial-block view. */
const blocksOf = (draft: Manifest): QualityBlocks => draft as unknown as QualityBlocks;

/**
 * `draft` with the rewritten blocks merged back over it, as a `Manifest`.
 *
 * The spread is the load-bearing line: the draft is REPLACED with a new object
 * carrying the new blocks, never mutated in place, because `setDraftManifest`
 * compares `draft` against `lastSaved` to decide which tabs are dirty and a
 * mutated object would make every tab look edited at once.
 */
const withBlocks = (draft: Manifest, blocks: QualityBlocks): Manifest =>
  ({ ...draft, ...blocks }) as unknown as Manifest;

/** Write one patch into `draft.uat`, spreading whatever the block already has. */
export function updateUat(draft: Manifest, patch: UatPatch): Manifest {
  const blocks = blocksOf(draft);
  const next: DraftUat = { ...(blocks.uat ?? {}), ...patch };
  if (patch.testerObservations === undefined) {
    delete next.testerObservations;
  }
  return withBlocks(draft, { ...blocks, uat: next });
}

/** Write one patch into `draft.review`, spreading whatever the block already has. */
export function updateReview(draft: Manifest, patch: ReviewPatch): Manifest {
  const blocks = blocksOf(draft);
  return withBlocks(draft, {
    ...blocks,
    review: { ...(blocks.review ?? {}), ...patch },
  });
}

/**
 * Write one `review.findings` field.
 *
 * Merged over the DEFAULTS rather than over the draft alone: with a draft that
 * omits the block, patching only `maxFindings` would otherwise write a
 * `findings` block with one key and drop the enabled/severity the validator
 * fills in — and those defaults are what make the lane blocking.
 */
export function updateFindings(
  draft: Manifest,
  patch: NonNullable<ReviewPatch['findings']>,
): Manifest {
  return updateReview(draft, {
    findings: {
      ...REVIEW_FINDINGS_DEFAULTS,
      ...(blocksOf(draft).review?.findings ?? {}),
      ...patch,
    },
  });
}

/** One block's per-repository overrides, as the tab edits them. */
type Override = { gates?: GateDef[] };
type Overrides = Readonly<Record<string, Override>>;

/**
 * Route a gate edit to the block it belongs to.
 *
 * `block` is `'uat'`, `'review'`, or `'uat:<repo>'` / `'review:<repo>'` for a
 * per-repository override. An override REPLACES the global list for that
 * repository — never extends it — so the write goes to
 * `<block>.repositories.<repo>.gates` and the global list is untouched.
 */
export function writeGates(draft: Manifest, block: string, gates: readonly GateDef[]): Manifest {
  const { base, repo } = parseGateBlock(block);
  const update = base === 'uat' ? updateUat : updateReview;
  if (repo === null) return update(draft, { gates: [...gates] });
  const next: Record<string, Override> = { ...readRepositories(draft, base) };
  next[repo] = { ...next[repo], gates: [...gates] };
  return update(draft, { repositories: next as never });
}

/**
 * Apply `fn` to the block's gate list AS IT IS IN `draft` — the reducer's
 * current draft, not the list a row rendered with. Two edits that land before
 * a re-render (text commits run as transitions) would otherwise each write
 * their own stale copy, and the later one would erase the earlier.
 */
export function updateGates(
  draft: Manifest,
  block: string,
  fn: (gates: readonly GateDef[]) => readonly GateDef[],
): Manifest {
  const { base, repo } = parseGateBlock(block);
  const current =
    repo === null
      ? ((blocksOf(draft)[base] as { gates?: GateDef[] } | undefined)?.gates ?? [])
      : (readRepositories(draft, base)[repo]?.gates ?? []);
  return writeGates(draft, block, fn(current));
}

function readRepositories(draft: Manifest, base: Base): Overrides {
  return (blocksOf(draft)[base] as { repositories?: Overrides } | undefined)?.repositories ?? {};
}

/** Split `'review:api'` into its base and repository; a global block has none. */
export function parseGateBlock(block: string): { base: 'uat' | 'review'; repo: string | null } {
  const at = block.indexOf(':');
  if (at < 0) return { base: block === 'uat' ? 'uat' : 'review', repo: null };
  return {
    base: block.slice(0, at) === 'uat' ? 'uat' : 'review',
    repo: block.slice(at + 1),
  };
}

/**
 * Seed a NEW per-repository override with a COPY of the global list.
 *
 * A copy, not a shared reference: editing an override must never mutate the
 * global list, or removing the override would silently take the edits with it.
 * Copying the global list up front is also what makes "replace, don't extend"
 * visible — the user can delete a gate in the override and see it not run.
 */
export function addRepoOverride(
  draft: Manifest,
  base: Base,
  repo: string,
  globalGates: readonly GateDef[],
): Manifest {
  const update = base === 'uat' ? updateUat : updateReview;
  const next: Record<string, Override> = { ...readRepositories(draft, base) };
  // A COPY of the global list, never the same reference: editing the override
  // must not mutate the global one, or removing the override would take the
  // edits with it.
  next[repo] = { ...next[repo], gates: globalGates.map((gate) => ({ ...gate })) };
  return update(draft, { repositories: next as never });
}

/** Drop the override key, falling that repository back to the global list. */
export function removeRepoOverride(draft: Manifest, base: Base, repo: string): Manifest {
  const update = base === 'uat' ? updateUat : updateReview;
  const repositories: Record<string, Override> = { ...readRepositories(draft, base) };
  delete repositories[repo];
  return update(draft, { repositories });
}

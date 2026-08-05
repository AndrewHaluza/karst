/**
 * The one place a token is priced relative to another (§ token consumption
 * stats).
 *
 * `total_tokens` is the sum of four counts that are NOT interchangeable, and
 * summing them unweighted is what made the stats view unreadable: a headless run
 * is an agentic loop, every turn re-reads the whole context from the prompt
 * cache, and the provider reports that re-read cumulatively. So a call whose real
 * work was one 3k-token PR body reported 900k tokens, 90% of them cache reads
 * billed at a tenth of an input token. Ranked on that number the view ranks call
 * sites by HOW MANY TURNS THEY TOOK, not by what they cost — and it did: the
 * one-call `review-findings` outranked fifteen `ticket-analysis` calls.
 *
 * The weights are input-equivalents, taken from the published Anthropic ratios,
 * which are the same for every Claude model — so ONE weight set is correct for
 * the whole ledger and nothing here has to branch on `model`. They are ratios,
 * deliberately not dollars: a currency figure would have to track per-model
 * prices that change, would go stale silently, and would state a precision the
 * ledger does not have (the counts include `estimated` rows).
 *
 * The raw counts are never replaced. `total_tokens` stays exactly what the
 * provider reported and remains queryable and displayable beside this — an
 * effective total is a lens, and a lens that destroys the measurement it is
 * applied to cannot be checked.
 */

/** Input-equivalent price of one token of each kind. Ratios, never dollars. */
export const TOKEN_WEIGHTS = {
  /** The baseline: one fresh, uncached input token. */
  input: 1,
  /** Output is the expensive half of every provider's price sheet. */
  output: 5,
  /** A cache hit — the reason a long agentic loop is cheap despite its size. */
  cacheRead: 0.1,
  /** Writing the cache costs slightly more than sending the tokens plainly. */
  cacheWrite: 1.25,
} as const;

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * The input-equivalent size of one call (or one group's sums). Rounded to a
 * whole token: the weights produce fractions that no display would ever show,
 * and a fraction leaking into a share calculation is noise, not precision.
 */
export function effectiveTokens(counts: TokenCounts): number {
  return Math.round(
    counts.input * TOKEN_WEIGHTS.input +
      counts.output * TOKEN_WEIGHTS.output +
      counts.cacheRead * TOKEN_WEIGHTS.cacheRead +
      counts.cacheWrite * TOKEN_WEIGHTS.cacheWrite,
  );
}

/**
 * The same arithmetic as a SQL expression, built from the SAME constants, so the
 * aggregate SQLite computes can never disagree with what `effectiveTokens` says
 * about one row. `p` is the table-alias prefix, for the ambiguity reason the rest
 * of `tokenUsage.ts` needs one; the interpolated values are these module-local
 * numbers and never anything a caller supplied.
 */
export function effectiveTokensSql(p = ''): string {
  return (
    `${p}input_tokens * ${TOKEN_WEIGHTS.input}` +
    ` + ${p}output_tokens * ${TOKEN_WEIGHTS.output}` +
    ` + ${p}cache_read_tokens * ${TOKEN_WEIGHTS.cacheRead}` +
    ` + ${p}cache_write_tokens * ${TOKEN_WEIGHTS.cacheWrite}`
  );
}

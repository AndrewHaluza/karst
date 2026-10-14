import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveInsideCheckout } from './args.mjs';

const ROOT = '/work';

describe('resolveInsideCheckout', () => {
  it('resolves a relative path against the checkout root', () => {
    expect(resolveInsideCheckout('.uat-out/smoke', ROOT)).toBe('/work/.uat-out/smoke');
  });

  it('keeps an absolute path that is already inside the root', () => {
    expect(resolveInsideCheckout('/work/.uat-out/blocked', ROOT)).toBe('/work/.uat-out/blocked');
  });

  it('refuses an absolute path outside the root', () => {
    expect(() => resolveInsideCheckout('/tmp/out', ROOT)).toThrow(/outside the checkout/);
  });

  it('refuses a relative path that escapes the root', () => {
    expect(() => resolveInsideCheckout('../escape', ROOT)).toThrow(/outside the checkout/);
  });

  it('refuses the root itself', () => {
    expect(() => resolveInsideCheckout('.', ROOT)).toThrow(/outside the checkout/);
  });

  it('names the resolved path and the checkout in the refusal', () => {
    expect(() => resolveInsideCheckout('/tmp/out', ROOT)).toThrow(/\/tmp\/out[\s\S]*\/work/);
  });
});

// A symlinked `--out` inside the checkout can still point OUT of it. The Docker
// harness follows the link inside the container, writes its evidence there, and
// the host is left with nothing at the declared path — the exact silent loss
// the guard exists to stop (UAT-tester finding, T694). These need real links, so
// they run against a temp checkout rather than the string-only cases above.
describe('resolveInsideCheckout follows symlinks', () => {
  let base;
  let checkout;
  let outside;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'karst-uat-args-'));
    checkout = join(base, 'checkout');
    outside = join(base, 'outside');
    mkdirSync(join(checkout, '.uat-out'), { recursive: true });
    mkdirSync(outside, { recursive: true });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('refuses a link whose target exists outside the checkout', () => {
    symlinkSync(outside, join(checkout, '.uat-out', 'link'));
    expect(() => resolveInsideCheckout('.uat-out/link', checkout)).toThrow(/outside the checkout/);
  });

  it('refuses a dangling link whose target is outside the checkout', () => {
    symlinkSync(join(outside, 'gone'), join(checkout, '.uat-out', 'dangling'));
    expect(() => resolveInsideCheckout('.uat-out/dangling', checkout)).toThrow(/outside the checkout/);
  });

  it('refuses a path that leaves the checkout through an intermediate link', () => {
    symlinkSync(outside, join(checkout, '.uat-out', 'hop'));
    expect(() => resolveInsideCheckout('.uat-out/hop/evidence', checkout)).toThrow(
      /outside the checkout/,
    );
  });

  it('refuses a chain through a second link that ends outside the checkout', () => {
    // a -> c -> <outside>/gone. The first hop is dangling, so a resolver that
    // stops at one lexical hop reads it as inside — but the OS follows the
    // whole chain, so evidence lands outside (review finding, T694).
    symlinkSync('c', join(checkout, '.uat-out', 'a'));
    symlinkSync(join(outside, 'gone'), join(checkout, '.uat-out', 'c'));
    expect(() => resolveInsideCheckout('.uat-out/a', checkout)).toThrow(/outside[/\\]gone/);
  });

  it('refuses a dangling link whose target passes through a link out of the checkout', () => {
    symlinkSync(outside, join(checkout, '.uat-out', 'hop'));
    symlinkSync(join(checkout, '.uat-out', 'hop', 'gone'), join(checkout, '.uat-out', 'a2'));
    expect(() => resolveInsideCheckout('.uat-out/a2', checkout)).toThrow(/outside[/\\]gone/);
  });

  it('accepts a link whose target exists inside the checkout', () => {
    mkdirSync(join(checkout, 'evidence'));
    symlinkSync(join(checkout, 'evidence'), join(checkout, '.uat-out', 'ok'));
    expect(resolveInsideCheckout('.uat-out/ok', checkout)).toBe(join(checkout, '.uat-out', 'ok'));
  });

  it('accepts a not-yet-created directory inside the checkout', () => {
    expect(resolveInsideCheckout('.uat-out/new/deeper', checkout)).toBe(
      join(checkout, '.uat-out', 'new', 'deeper'),
    );
  });
});

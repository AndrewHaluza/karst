import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** A link cycle cannot be resolved; stop and hand back what we have. */
const MAX_LINK_HOPS = 40;

/**
 * Real path of `p`, following EVERY symlink in the chain, even when the final
 * target does not exist yet (or at all).
 *
 * Resolution walks from the filesystem root component by component. Each
 * existing component is taken as itself unless it is a symlink, in which case
 * resolution RESTARTS from the link's target — so a link to another link, and a
 * link whose target passes through a link outside the tree, are both followed
 * the way the OS would follow them. A missing component ends the walk; the
 * not-yet-created tail is appended lexically because it cannot itself be a
 * link. This is what makes a container-only escape (a link at a path the host
 * cannot see) still read as outside the checkout.
 */
function realPathOfDeepestExisting(input) {
  let path = resolve(input);
  for (let hops = 0; hops <= MAX_LINK_HOPS; hops++) {
    const parts = path.split(sep);
    let real = parts[0] + sep;
    let linkTarget = null;
    let i = 1;
    for (; i < parts.length; i++) {
      const next = join(real, parts[i]);
      let stat;
      try {
        stat = lstatSync(next);
      } catch {
        return join(real, ...parts.slice(i)); // missing component: append the tail
      }
      if (stat.isSymbolicLink()) {
        linkTarget = resolve(real, readlinkSync(next));
        break;
      }
      real = next;
    }
    if (linkTarget === null) return real; // every component resolved to a real one
    path = join(linkTarget, ...parts.slice(i + 1)); // restart at the link target
  }
  return path;
}

/**
 * Resolve a user-supplied `--out` / `--script` path against the checkout root
 * and refuse anything that escapes it — lexically OR through any symlink chain.
 *
 * The Docker harness (`docker.mjs`) bind-mounts ONLY the checkout root. A path
 * that resolves outside it is written inside the container and thrown away with
 * it — the run may even pass while leaving the host with no evidence to cite,
 * which is exactly the silent loss the UAT-tester's instructions warn about.
 * Failing fast here turns that footgun into a named error before a host boots.
 *
 * Containment is checked on the REAL path, so a link inside the checkout that
 * points out of it is refused too; the lexical path is returned unchanged,
 * because that is what the container (mount at the checkout) resolves.
 */
export function resolveInsideCheckout(value, checkoutRoot) {
  const resolved = resolve(checkoutRoot, value);
  let rootReal;
  try {
    rootReal = realpathSync(checkoutRoot);
  } catch {
    rootReal = resolve(checkoutRoot);
  }
  const targetReal = realPathOfDeepestExisting(resolved);
  const rel = relative(rootReal, targetReal);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    const real = targetReal === resolved ? '' : ` (real path ${targetReal})`;
    throw new Error(
      `uat-host: path is outside the checkout: ${value}\n` +
        `  resolved to ${resolved}${real}\n` +
        `  the Docker harness bind-mounts only ${checkoutRoot}; ` +
        `evidence written outside it is discarded with the container.`,
    );
  }
  return resolved;
}

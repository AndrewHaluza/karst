/**
 * Minimal glob matcher for `outputs:` globs (already validated repo-relative by
 * `validateOutputs`). Supports `**`, `*`, `?`, `[set]` and `{a,b}`; no deps,
 * no fs. `*` and `?` never cross a `/`; `**` does; a trailing `/**` also
 * matches everything below the directory.
 */

import type { TaggedOutput } from '../approaches/outputs.js';

const REGEX_SPECIALS = /[.+^$()|\\]/;

function escapeChar(c: string): string {
  return REGEX_SPECIALS.test(c) ? `\\${c}` : c;
}

export function globToRegExp(glob: string): RegExp {
  let out = '';
  let braceDepth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slashAfter = glob[i + 2] === '/';
        // `**/` matches zero or more whole directories; bare `**` matches anything.
        out += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end === -1) {
        out += '\\[';
      } else {
        const body = glob.slice(i + 1, end);
        out += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
        i = end;
      }
    } else if (c === '{') {
      braceDepth += 1;
      out += '(?:';
    } else if (c === '}' && braceDepth > 0) {
      braceDepth -= 1;
      out += ')';
    } else if (c === ',' && braceDepth > 0) {
      out += '|';
    } else {
      out += escapeChar(c);
    }
  }
  return new RegExp(`^${out}$`);
}

/** The first output whose glob matches `relPath`, or undefined. */
export function matchOutput(
  outputs: readonly TaggedOutput[],
  relPath: string,
): TaggedOutput | undefined {
  return outputs.find((o) => globToRegExp(o.glob).test(relPath));
}

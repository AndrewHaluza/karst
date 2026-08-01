import { describe, it, expect } from 'vitest';
import { parseTokenBody, parseTemplateTokens } from './token.js';
import {
  TRANSFORM_NAMES,
  applyTransforms,
  validateTemplateTransforms,
  renderValue,
} from './transforms.js';

/** Apply the chain written in `body` to `value` — the shape every case uses. */
function run(value: unknown, body: string): string {
  const token = parseTokenBody(body);
  return applyTransforms(value, token.transforms);
}

/** The validation error raised for `template`, or '' when it validates. */
function error(template: string): string {
  try {
    validateTemplateTransforms('ticketLabelTemplate', parseTemplateTokens(template));
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

describe('renderValue', () => {
  it('coerces every runtime shape to a string without throwing', () => {
    expect(renderValue('abc')).toBe('abc');
    expect(renderValue('')).toBe('');
    expect(renderValue(null)).toBe('');
    expect(renderValue(undefined)).toBe('');
    expect(renderValue(142)).toBe('142');
    expect(renderValue(0)).toBe('0');
    expect(renderValue(false)).toBe('false');
    expect(renderValue(['a', 'b'])).toBe('a,b');
  });

  it('an object with a broken toString degrades to empty rather than throwing', () => {
    const hostile = {
      toString() {
        throw new Error('boom');
      },
    };
    expect(renderValue(hostile)).toBe('');
  });
});

describe('applyTransforms — no transforms', () => {
  it('an empty chain returns the coerced value unchanged', () => {
    expect(run('869e82530', '')).toBe('869e82530');
    expect(run('869e82530', 'key')).toBe('869e82530');
    expect(run(null, 'key')).toBe('');
  });
});

describe('slice', () => {
  it('keeps the distinguishing tail of look-alike ticket ids', () => {
    expect(run('869e82530', 'key|slice:-4')).toBe('2530');
    expect(run('869e820e2', 'key|slice:-4')).toBe('20e2');
  });

  it('start only, start and end, and negative indices match String.slice', () => {
    expect(run('abcdef', 'k|slice:2')).toBe('cdef');
    expect(run('abcdef', 'k|slice:1,3')).toBe('bc');
    expect(run('abcdef', 'k|slice:-3')).toBe('def');
    expect(run('abcdef', 'k|slice:-4,-2')).toBe('cd');
    expect(run('abcdef', 'k|slice:0')).toBe('abcdef');
    expect(run('abcdef', 'k|slice:-0')).toBe('abcdef');
  });

  it('out-of-range indices and start >= end yield the empty string like JS', () => {
    expect(run('abc', 'k|slice:10')).toBe('');
    expect(run('abc', 'k|slice:-99')).toBe('abc');
    expect(run('abc', 'k|slice:2,1')).toBe('');
    expect(run('abc', 'k|slice:1,1')).toBe('');
    expect(run('abc', 'k|slice:0,99')).toBe('abc');
  });

  it('empty and absent source values slice to empty, never throw', () => {
    expect(run('', 'k|slice:-4')).toBe('');
    expect(run(null, 'k|slice:-4')).toBe('');
    expect(run(undefined, 'k|slice:1,3')).toBe('');
  });

  it('slices UTF-16 code units exactly as String.prototype.slice does', () => {
    // '🙂' is one code point but two code units — documented behavior.
    expect(run('🙂ab', 'k|slice:2')).toBe('ab');
    expect(run('ab🙂', 'k|slice:-2')).toBe('🙂');
    expect(run('🙂ab', 'k|slice:0,1')).toBe('\ud83d');
  });
});

describe('truncate', () => {
  it('shortens only when longer than the width, marking the cut', () => {
    expect(run('abcdefgh', 'k|truncate:5')).toBe('abcd…');
    expect(run('abcde', 'k|truncate:5')).toBe('abcde');
    expect(run('abc', 'k|truncate:5')).toBe('abc');
  });

  it('accepts a custom marker, counted inside the width budget', () => {
    expect(run('abcdefgh', 'k|truncate:5,...')).toBe('ab...');
    expect(run('abcdefgh', 'k|truncate:5,')).toBe('abcde');
  });

  it('a marker at least as wide as the budget degrades to a hard cut', () => {
    expect(run('abcdefgh', 'k|truncate:2,...')).toBe('ab');
    expect(run('abcdefgh', 'k|truncate:1')).toBe('a');
  });

  it('counts code points, so an emoji is never split into half a surrogate', () => {
    expect(run('🙂🙂🙂🙂', 'k|truncate:3')).toBe('🙂🙂…');
    expect(run('🙂🙂', 'k|truncate:2')).toBe('🙂🙂');
  });

  it('empty and absent values pass through untouched', () => {
    expect(run('', 'k|truncate:5')).toBe('');
    expect(run(null, 'k|truncate:5')).toBe('');
  });
});

describe('case transforms', () => {
  it('upper and lower map the whole value', () => {
    expect(run('PROJ-142', 'k|lower')).toBe('proj-142');
    expect(run('proj-142', 'k|upper')).toBe('PROJ-142');
    expect(run('', 'k|upper')).toBe('');
    expect(run(null, 'k|lower')).toBe('');
  });

  it('kebab and snake collapse every non-alphanumeric run to one separator', () => {
    expect(run('Add Login  Flow!', 'k|kebab')).toBe('add-login-flow');
    expect(run('Add Login  Flow!', 'k|snake')).toBe('add_login_flow');
    expect(run('--Trim me--', 'k|kebab')).toBe('trim-me');
    expect(run('__trim me__', 'k|snake')).toBe('trim_me');
  });

  it('kebab and snake keep non-ASCII letters and digits', () => {
    expect(run('Привет мир', 'k|kebab')).toBe('привет-мир');
    expect(run('版本 2', 'k|snake')).toBe('版本_2');
  });

  it('a value with nothing alphanumeric collapses to empty, never throws', () => {
    expect(run('!!!', 'k|kebab')).toBe('');
    expect(run('', 'k|snake')).toBe('');
    expect(run(undefined, 'k|kebab')).toBe('');
  });
});

describe('trim', () => {
  it('removes leading and trailing whitespace, keeping the interior', () => {
    expect(run('  add login  ', 'k|trim')).toBe('add login');
    expect(run('\n\tadd\tlogin\n', 'k|trim')).toBe('add\tlogin');
    expect(run('   ', 'k|trim')).toBe('');
    expect(run('', 'k|trim')).toBe('');
    expect(run(null, 'k|trim')).toBe('');
    expect(run(undefined, 'k|trim')).toBe('');
  });
});

describe('default', () => {
  it('substitutes only when the value is empty', () => {
    expect(run('working', 'status|default:idle')).toBe('working');
    expect(run('', 'status|default:idle')).toBe('idle');
    expect(run(null, 'status|default:idle')).toBe('idle');
    expect(run(undefined, 'status|default:idle')).toBe('idle');
  });

  it('takes its argument verbatim, commas and spaces included', () => {
    expect(run('', 'status|default: not started, yet')).toBe(' not started, yet');
  });

  it('a whitespace-only value is not empty unless trimmed first', () => {
    expect(run('   ', 'status|default:idle')).toBe('   ');
    expect(run('   ', 'status|trim|default:idle')).toBe('idle');
  });
});

describe('chaining', () => {
  it('applies transforms left to right', () => {
    expect(run('869e82530', 'key|slice:-4|upper')).toBe('2530');
    expect(run('  Add Login  ', 'title|trim|kebab|truncate:6')).toBe('add-l…');
    expect(run('add login', 'title|truncate:6|upper')).toBe('ADD L…');
    expect(run('add login', 'title|upper|truncate:6')).toBe('ADD L…');
  });

  it('order is observable — the same pair in reverse gives a different result', () => {
    expect(run('  add login  ', 'k|trim|slice:0,3')).toBe('add');
    expect(run('  add login  ', 'k|slice:0,3|trim')).toBe('a');
    expect(run('Add Login', 'k|kebab|slice:0,4')).toBe('add-');
    expect(run('Add Login', 'k|slice:0,4|kebab')).toBe('add');
  });

  it('a default early in the chain feeds the transforms after it', () => {
    expect(run('', 'status|default:Not Started|kebab')).toBe('not-started');
    expect(run('', 'status|kebab|default:Not Started')).toBe('Not Started');
  });

  it('never mutates the value it was handed', () => {
    const source = ['a', 'b'];
    expect(run(source, 'k|upper')).toBe('A,B');
    expect(source).toEqual(['a', 'b']);
  });

  it('never mutates the parsed transform specs', () => {
    const token = parseTokenBody('key|slice:-4|upper');
    const before = JSON.stringify(token);
    applyTransforms('869e82530', token.transforms);
    expect(JSON.stringify(token)).toBe(before);
  });
});

describe('validateTemplateTransforms', () => {
  it('accepts every template that uses no transforms', () => {
    expect(error('{key} — {title}')).toBe('');
    expect(error('plain text')).toBe('');
    expect(error('{}')).toBe('');
  });

  it('names the offending placeholder and the reason for an unknown transform', () => {
    expect(error('{key|slize:-4}')).toBe(
      'ticketLabelTemplate contains unknown transform "slize" in "{key|slize:-4}" ' +
        `(supported: ${TRANSFORM_NAMES.join(', ')})`,
    );
  });

  it('rejects an empty transform name', () => {
    expect(error('{key|}')).toBe(
      'ticketLabelTemplate contains an empty transform name in "{key|}"',
    );
  });

  it('rejects a non-integer or missing slice index instead of coercing it', () => {
    expect(error('{key|slice:x}')).toBe(
      'ticketLabelTemplate has an invalid "slice" argument in "{key|slice:x}": ' +
        'start must be an integer',
    );
    expect(error('{key|slice:1.5}')).toContain('start must be an integer');
    expect(error('{key|slice: -4}')).toContain('start must be an integer');
    expect(error('{key|slice:1,}')).toContain('end must be an integer');
    expect(error('{key|slice:1,x}')).toContain('end must be an integer');
    expect(error('{key|slice}')).toBe(
      'ticketLabelTemplate has an invalid "slice" argument in "{key|slice}": ' +
        'slice requires a start index, e.g. {key|slice:-4}',
    );
    expect(error('{key|slice:}')).toContain('start must be an integer');
  });

  it('rejects a truncate width that is not a positive integer', () => {
    expect(error('{title|truncate:0}')).toContain('width must be a positive integer');
    expect(error('{title|truncate:-3}')).toContain('width must be a positive integer');
    expect(error('{title|truncate:abc}')).toContain('width must be a positive integer');
    expect(error('{title|truncate}')).toContain('truncate requires a width');
  });

  it('rejects arguments passed to a transform that takes none', () => {
    expect(error('{key|upper:2}')).toBe(
      'ticketLabelTemplate has an invalid "upper" argument in "{key|upper:2}": ' +
        'upper takes no arguments',
    );
    expect(error('{key|trim:}')).toContain('trim takes no arguments');
  });

  it('rejects a default with no replacement value', () => {
    expect(error('{status|default}')).toContain('default requires a replacement value');
    expect(error('{status|default:}')).toContain('default requires a replacement value');
  });

  it('reports the first bad transform in a chain', () => {
    expect(error('{key|slice:-4|nope|alsonope}')).toContain('unknown transform "nope"');
  });

  it('accepts every documented transform', () => {
    expect(error('{key|slice:-4}{key|slice:1,3}{title|truncate:20}')).toBe('');
    expect(error('{title|truncate:20,...}{title|upper}{title|lower}')).toBe('');
    expect(error('{title|kebab}{title|snake}{title|trim}{status|default:none}')).toBe('');
  });

  it('prefixes the error with whichever field is being validated', () => {
    const tokens = parseTemplateTokens('{key|slize}');
    expect(() => validateTemplateTransforms('conventions.branchName', tokens)).toThrow(
      /^conventions\.branchName contains unknown transform "slize"/,
    );
  });
});

/**
 * The worked examples in README.md's "Placeholder transforms" table. Pinned so
 * the documentation cannot drift from what the engine actually renders.
 */
describe('documented worked examples', () => {
  const key = '869e82530';
  const title = '  Add login flow  ';

  it('renders the ticket-id shortening case that motivated transforms', () => {
    expect(run('869e82530', 'key|slice:-4')).toBe('2530');
    expect(run('869e820e2', 'key|slice:-4')).toBe('20e2');
  });

  it('renders every row of the README example table', () => {
    expect(run(key, 'key|slice:-4')).toBe('2530');
    expect(run(key, 'key|slice:0,3')).toBe('869');
    expect(run(key, 'key|slice:2')).toBe('9e82530');
    expect(run(key, 'key|slice:-4,-2')).toBe('25');
    expect(run(title, 'title|trim|truncate:8')).toBe('Add log…');
    expect(run(title, 'title|trim|truncate:8,...')).toBe('Add l...');
    expect(run(title, 'title|trim|kebab')).toBe('add-login-flow');
    expect(run(title, 'title|trim|snake')).toBe('add_login_flow');
    expect(run(key, 'key|slice:-4|upper')).toBe('2530');
    expect(run('', 'status|default:idle')).toBe('idle');
  });

  it('renders the documented multi-comma argument cases', () => {
    expect(run('a long enough title here', 'title|truncate:20,, …')).toBe('a long enough tit, …');
    expect(run('', 'status|default:not started, yet')).toBe('not started, yet');
  });
});

import { describe, it, expect, vi } from 'vitest';
import { parseFindings, type ParseFindingsContext } from './findings.js';

const WORKTREE = '/Users/dev/work/karst-worktree/svc-a';

const CTX: ParseFindingsContext = { repo: 'svc-a', worktreePath: WORKTREE, max: 50 };

function ctx(overrides: Partial<ParseFindingsContext> = {}): ParseFindingsContext {
  return { ...CTX, ...overrides };
}

/** A well-formed finding object, the shape an agent is asked to emit. */
function findingObj(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    severity: 'high',
    file: 'src/index.ts',
    line: 12,
    title: 'Missing null check',
    detail: 'The function dereferences `x` without checking it is defined first.',
    ...overrides,
  };
}

describe('parseFindings — reading whole-document JSON and JSONL', () => {
  it('reads findings from a whole-document JSON array', () => {
    const raw = JSON.stringify([findingObj({ title: 'one' }), findingObj({ title: 'two' })]);
    const result = parseFindings(raw, ctx());
    expect(result.map((f) => f.title)).toEqual(['one', 'two']);
  });

  it('reads findings from a whole-document JSON object carrying a findings array', () => {
    const raw = JSON.stringify({ findings: [findingObj({ title: 'wrapped' })] });
    const result = parseFindings(raw, ctx());
    expect(result.map((f) => f.title)).toEqual(['wrapped']);
  });

  it('reads findings from JSONL where the interesting line is not line 1', () => {
    const raw = [
      JSON.stringify({ type: 'thread.started', thread_id: 'th_1' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'looking...' } }),
      JSON.stringify({ findings: [findingObj({ title: 'line 3 finding' })] }),
    ].join('\n');
    const result = parseFindings(raw, ctx());
    expect(result.map((f) => f.title)).toEqual(['line 3 finding']);
  });

  it('reads a JSONL stream where each line is one bare finding object', () => {
    const raw = [
      JSON.stringify(findingObj({ title: 'a' })),
      JSON.stringify(findingObj({ title: 'b' })),
    ].join('\n');
    const result = parseFindings(raw, ctx());
    expect(result.map((f) => f.title)).toEqual(['a', 'b']);
  });

  it('ignores unparseable JSONL lines and keeps the ones that parse', () => {
    const raw = [
      'not json at all {{{',
      JSON.stringify(findingObj({ title: 'survives' })),
      '}}} also not json',
    ].join('\n');
    const result = parseFindings(raw, ctx());
    expect(result.map((f) => f.title)).toEqual(['survives']);
  });
});

describe('parseFindings — severity is a closed vocabulary, never coerced', () => {
  it('drops a finding whose severity is unrecognized, case included', () => {
    const raw = JSON.stringify([
      findingObj({ title: 'wrong case', severity: 'CRITICAL' }),
      findingObj({ title: 'unknown word', severity: 'urgent' }),
      findingObj({ title: 'kept', severity: 'critical' }),
    ]);
    const result = parseFindings(raw, ctx());
    expect(result.map((f) => f.title)).toEqual(['kept']);
  });

  it('drops a finding with no severity at all', () => {
    const obj = findingObj({ title: 'no severity' });
    delete obj.severity;
    const result = parseFindings(JSON.stringify([obj]), ctx());
    expect(result).toEqual([]);
  });

  it('accepts every member of the closed vocabulary', () => {
    const raw = JSON.stringify(
      ['critical', 'high', 'medium', 'low', 'info'].map((severity) =>
        findingObj({ title: severity, severity }),
      ),
    );
    const result = parseFindings(raw, ctx());
    expect(result.map((f) => f.severity)).toEqual(['critical', 'high', 'medium', 'low', 'info']);
  });
});

describe('parseFindings — file must be repo-relative and stay inside the worktree', () => {
  it('keeps a repo-relative file that resolves inside the worktree', () => {
    const result = parseFindings(JSON.stringify([findingObj({ file: 'src/index.ts' })]), ctx());
    expect(result[0]?.file).toBe('src/index.ts');
  });

  it('keeps the finding but nulls the file for a classic traversal escape, and logs it', () => {
    const warn = vi.fn();
    const raw = JSON.stringify([
      findingObj({ title: 'ssh key', file: '../../../.ssh/id_rsa' }),
    ]);
    const result = parseFindings(raw, ctx(), warn);
    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe('ssh key');
    expect(result[0]?.file).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('keeps the finding but nulls the file for an absolute path', () => {
    const raw = JSON.stringify([findingObj({ file: '/etc/passwd' })]);
    const result = parseFindings(raw, ctx());
    expect(result[0]?.file).toBeNull();
  });

  it('keeps the finding but nulls the file for a path with a .. segment even if it resolves inside', () => {
    const raw = JSON.stringify([findingObj({ file: 'src/../src/index.ts' })]);
    const result = parseFindings(raw, ctx());
    expect(result[0]?.file).toBeNull();
  });

  it('keeps the finding but nulls the file when the value is not a string', () => {
    const raw = JSON.stringify([findingObj({ file: 42 })]);
    const result = parseFindings(raw, ctx());
    expect(result).toHaveLength(1);
    expect(result[0]?.file).toBeNull();
  });

  it('treats an absent file as "not file-scoped", not an error — no warning', () => {
    const warn = vi.fn();
    const obj = findingObj();
    delete obj.file;
    delete obj.line;
    const result = parseFindings(JSON.stringify([obj]), ctx(), warn);
    expect(result[0]?.file).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('always attributes a finding to ctx.repo, ignoring an attacker-supplied repo field', () => {
    const raw = JSON.stringify([findingObj({ repo: 'some-other-repo-entirely' })]);
    const result = parseFindings(raw, ctx({ repo: 'svc-a' }));
    expect(result[0]?.repo).toBe('svc-a');
  });
});

describe('parseFindings — line must be a positive integer', () => {
  it.each([0, -1, 3.5, '10', true, Number.NaN])(
    'nulls the line (keeps the finding) for an invalid line value: %p',
    (badLine) => {
      const raw = JSON.stringify([findingObj({ line: badLine })]);
      const result = parseFindings(raw, ctx());
      expect(result).toHaveLength(1);
      expect(result[0]?.line).toBeNull();
    },
  );

  it('keeps a valid positive integer line', () => {
    const raw = JSON.stringify([findingObj({ line: 42 })]);
    const result = parseFindings(raw, ctx());
    expect(result[0]?.line).toBe(42);
  });

  it('nulls the line when the file it names was rejected as untrustworthy', () => {
    const raw = JSON.stringify([findingObj({ file: '../../etc/passwd', line: 7 })]);
    const result = parseFindings(raw, ctx());
    expect(result[0]?.file).toBeNull();
    expect(result[0]?.line).toBeNull();
  });
});

describe('parseFindings — title/detail collapsed to one line and capped', () => {
  it('collapses a title with embedded newlines, tabs and whitespace runs', () => {
    const raw = JSON.stringify([
      findingObj({ title: 'Uses\n\ttabs   and\nnewlines\r\neverywhere' }),
    ]);
    const result = parseFindings(raw, ctx());
    expect(result[0]?.title).toBe('Uses tabs and newlines everywhere');
  });

  it('keeps a hostile title (shell metacharacters) as inert text, collapsed to one line', () => {
    const raw = JSON.stringify([
      findingObj({ title: '$(rm -rf /)\n\tdo not run this' }),
    ]);
    const result = parseFindings(raw, ctx());
    expect(result[0]?.title).toBe('$(rm -rf /) do not run this');
  });

  it('caps an oversized detail (5 MB) and marks the cut', () => {
    const huge = 'x'.repeat(5 * 1024 * 1024);
    const raw = JSON.stringify([findingObj({ detail: huge })]);
    const result = parseFindings(raw, ctx());
    const detail = result[0]?.detail ?? '';
    expect(detail.length).toBeLessThan(9000);
    expect(detail.endsWith('…')).toBe(true);
  });

  it('drops a finding with no usable title', () => {
    const obj = findingObj();
    delete obj.title;
    const result = parseFindings(JSON.stringify([obj]), ctx());
    expect(result).toEqual([]);
  });

  it('accepts a finding with no detail, defaulting it to an empty string', () => {
    const obj = findingObj();
    delete obj.detail;
    const result = parseFindings(JSON.stringify([obj]), ctx());
    expect(result[0]?.detail).toBe('');
  });
});

describe('parseFindings — over-max truncation is logged, never silent', () => {
  it('truncates beyond max and logs how many were dropped', () => {
    const warn = vi.fn();
    const raw = JSON.stringify(
      Array.from({ length: 5 }, (_, i) => findingObj({ title: `f${i}` })),
    );
    const result = parseFindings(raw, ctx({ max: 2 }), warn);
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.title)).toEqual(['f0', 'f1']);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]?.[0] as string;
    expect(message).toContain('3');
    expect(message.toLowerCase()).toMatch(/drop|truncat/);
  });

  it('does not warn when findings are within max', () => {
    const warn = vi.fn();
    const raw = JSON.stringify([findingObj()]);
    parseFindings(raw, ctx({ max: 50 }), warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it('drops everything and still logs when max is 0', () => {
    const warn = vi.fn();
    const raw = JSON.stringify([findingObj()]);
    const result = parseFindings(raw, ctx({ max: 0 }), warn);
    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

describe('parseFindings — unparseable input returns [], never a synthetic finding, never a throw', () => {
  it('returns [] for prose instead of JSON, and logs it distinctly from "nothing found"', () => {
    const warn = vi.fn();
    const raw = 'The code compiles fine. No issues worth flagging in this diff.';
    const result = parseFindings(raw, ctx(), warn);
    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalled();
    const message = warn.mock.calls[0]?.[0] as string;
    expect(message.toLowerCase()).not.toMatch(/drop|truncat/);
  });

  it('returns [] silently for a legitimate empty array — this is not an error', () => {
    const warn = vi.fn();
    const result = parseFindings('[]', ctx(), warn);
    expect(result).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns [] silently for {"findings": []}', () => {
    const warn = vi.fn();
    const result = parseFindings(JSON.stringify({ findings: [] }), ctx(), warn);
    expect(result).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns [] for a bare JSON null without throwing', () => {
    expect(() => parseFindings('null', ctx())).not.toThrow();
    expect(parseFindings('null', ctx())).toEqual([]);
  });

  it('returns [] for a bare JSON string without throwing', () => {
    expect(() => parseFindings(JSON.stringify('hello'), ctx())).not.toThrow();
    expect(parseFindings(JSON.stringify('hello'), ctx())).toEqual([]);
  });

  it('returns [] for an empty string without throwing', () => {
    expect(() => parseFindings('', ctx())).not.toThrow();
    expect(parseFindings('', ctx())).toEqual([]);
  });

  it('skips non-object entries inside a findings array and keeps the valid one', () => {
    const raw = JSON.stringify({
      findings: [findingObj({ title: 'kept' }), 'garbage', 42, null, [1, 2, 3], { foo: 'bar' }],
    });
    const result = parseFindings(raw, ctx());
    expect(result.map((f) => f.title)).toEqual(['kept']);
  });

  it('never throws on a deeply nested JSON document, and reports no findings', () => {
    const depth = 50_000;
    const raw = '['.repeat(depth) + ']'.repeat(depth);
    expect(() => parseFindings(raw, ctx())).not.toThrow();
    expect(parseFindings(raw, ctx())).toEqual([]);
  });

  it('never throws on an enormous flat document', () => {
    const raw = JSON.stringify([findingObj({ detail: 'y'.repeat(2 * 1024 * 1024) })]);
    expect(() => parseFindings(raw, ctx())).not.toThrow();
  });
});

describe('parseFindings — every finding carries source "agent"', () => {
  it('marks every parsed finding as agent-sourced', () => {
    const raw = JSON.stringify([findingObj()]);
    const result = parseFindings(raw, ctx());
    expect(result[0]?.source).toBe('agent');
  });
});

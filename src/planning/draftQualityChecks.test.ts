import { describe, it, expect } from 'vitest';
import {
  clipToken,
  draftQualityWarnings,
  extractReferencedPaths,
  jaccard,
  DROPPED_PLAN_WARNING,
  DUPLICATE_WARNING,
  INVERTED_WARNING,
  LEAK_WARNING,
  MAX_WARNING_CHARS,
  NO_PATHS_WARNING,
  NO_VERIFICATION_WARNING,
} from './draftQualityChecks.js';

/** `text` padded with ` z…` (no path, no verification word) to exactly `n` chars. */
const pad = (text: string, n: number): string => `${text} ${'z'.repeat(Math.max(0, n))}`.slice(0, n);
/** A unique 22-word line `w<k>x0 … w<k>x21` (about 130 chars). */
const line = (k: number): string => Array.from({ length: 22 }, (_, i) => `w${k}x${i}`).join(' ');

const CORE = 'Edit src/auth/session.ts. Verify with vitest.';
const WELL_DESC = pad(CORE, 200);
const WELL_SUM = pad('The login drops users when the token expires; renew it once.', 120);
const draft = (description: string, summary = WELL_SUM, repos: string[] = ['api']) => ({ description, summary, repos });

describe('clipToken', () => {
  it('keeps a short token and clips a long one from the front, keeping the tail', () => {
    expect(clipToken('abc', 3)).toBe('abc');
    expect(clipToken('abcd', 3)).toBe('…cd');
    expect(clipToken('src/very/long/path.ts', 8)).toBe('…path.ts');
    expect(clipToken('abcd', 3)).toHaveLength(3);
  });
});

describe('jaccard', () => {
  it('is |a∩b| / |a∪b|, and 0 for two empty sets', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3);
    expect(jaccard(new Set(['a']), new Set(['a']))).toBe(1);
    expect(jaccard(new Set(), new Set())).toBe(0);
  });
});

describe('extractReferencedPaths', () => {
  it('finds repo-relative paths under every root', () => {
    const roots = ['src', 'tests', 'scripts', 'docs', 'packages', 'lib', 'app', 'apps', 'cmd', 'internal', '.github'];
    const text = roots.map((r) => `${r}/x/file.ts`).join(' ');
    expect(extractReferencedPaths(text).existing).toEqual(roots.map((r) => `${r}/x/file.ts`));
  });
  it('strips URIs before matching', () => {
    const r = extractReferencedPaths('see https://github.com/o/r/blob/main/src/a.ts and file:///home/u/src/b.ts');
    expect(r).toEqual({ existing: [], created: [], anyPathCount: 0 });
  });
  it('does not match a root inside a longer path', () => {
    expect(extractReferencedPaths('/Users/me/src/a.ts foo/src/b.ts').existing).toEqual([]);
  });
  it('strips trailing punctuation, :line, #L anchors and a trailing slash', () => {
    const r = extractReferencedPaths('src/a.ts, src/b.ts. src/c.ts:12 src/d.ts:12:3 src/e.ts:10-20 src/f.ts#L10-L20 src/g/ (src/h.ts) `src/i.ts` **src/j.ts**');
    expect(r.existing).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts', 'src/g', 'src/h.ts', 'src/i.ts', 'src/j.ts']);
  });
  it('ignores globs and placeholders', () => {
    const r = extractReferencedPaths('src/**/*.ts src/a?.ts src/<name>.ts src/{a,b}.ts src/.../x.ts');
    expect(r).toEqual({ existing: [], created: [], anyPathCount: 0 });
  });
  it('dedupes and keeps the first order', () => {
    expect(extractReferencedPaths('src/b.ts src/a.ts src/b.ts').existing).toEqual(['src/b.ts', 'src/a.ts']);
  });
  it('counts root config files in anyPathCount only', () => {
    const r = extractReferencedPaths('package.json tsconfig.build.json Dockerfile Makefile ci.yml compose.yaml');
    expect(r.existing).toEqual([]);
    expect(r.anyPathCount).toBe(6);
  });
  it('does not count a config name that is part of a path twice', () => {
    expect(extractReferencedPaths('.github/workflows/ci.yml').anyPathCount).toBe(1);
  });
  it('classifies a path as created by a same-line marker', () => {
    for (const marker of ['[NEW]', '(new)', 'new file', 'Create ', 'creating ', 'add ']) {
      const r = extractReferencedPaths(`${marker} src/n.ts\nedit src/e.ts`);
      expect(r.created, marker).toEqual(['src/n.ts']);
      expect(r.existing, marker).toEqual(['src/e.ts']);
    }
  });
  it('classifies paths under a "New files" heading as created until the next heading', () => {
    const r = extractReferencedPaths('### New files\n- src/n.ts\n## Changes\n- src/c.ts');
    expect(r.created).toEqual(['src/n.ts']);
    expect(r.existing).toEqual(['src/c.ts']);
    expect(extractReferencedPaths('# New file\nsrc/one.ts').created).toEqual(['src/one.ts']);
  });
  it('a path that is created anywhere is never existing', () => {
    const r = extractReferencedPaths('[NEW] src/n.ts\nthen edit src/n.ts');
    expect(r).toEqual({ existing: [], created: ['src/n.ts'], anyPathCount: 1 });
  });
});

describe('draftQualityWarnings', () => {
  it('is silent for a well-formed draft', () => {
    expect(draftQualityWarnings(draft(WELL_DESC))).toEqual([]);
  });

  describe('session path leak', () => {
    const leaks = [
      '$KARST_ARTIFACTS/plan.md',
      '${KARST_ARTIFACTS}/plan.md',
      'planning-scratch/17/artifacts/plan.md',
      'globalStorage/karst.karst/planning-scratch/x/artifacts/p.md',
      '/tmp/abc/artifacts/plan.md',
      '/private/tmp/abc/artifacts/plan.md',
      '~/.gemini/antigravity/brain/123/plan.md',
      '~/.claude/plans/plan.md',
      '~/.claude/projects/-Users-me/memory/x.md',
      '~/.codex/sessions/x.md',
      '$HOME/.codex/x.md',
      '/Users/me/.codex/x.md',
      '/home/me/.codex/x.md',
      '.opencode/plans/p.md',
      'docs/superpowers/plans/2026-01-01-x.md',
    ];
    it.each(leaks)('flags %s in the description', (leak) => {
      expect(draftQualityWarnings(draft(`${WELL_DESC} ${leak}`))).toContain(LEAK_WARNING);
    });
    it('flags a leak in the summary too', () => {
      expect(draftQualityWarnings(draft(WELL_DESC, `${WELL_SUM} ~/.claude/plans/p.md`))).toContain(LEAK_WARNING);
    });
    it('does not flag a cite of a listed attachment (path or bare name)', () => {
      const d = {
        ...draft(`${WELL_DESC} See /artifacts/proto/a.html and a.html, or $KARST_ARTIFACTS/proto/a.html for the layout.`),
        attachments: [{ path: 'proto/a.html' }],
      };
      expect(draftQualityWarnings(d)).not.toContain(LEAK_WARNING);
    });
    it('keeps the warning for a path that is not listed', () => {
      const d = {
        ...draft(`${WELL_DESC} See /tmp/x/artifacts/proto/b.html for the layout.`),
        attachments: [{ path: 'proto/a.html' }],
      };
      expect(draftQualityWarnings(d)).toContain(LEAK_WARNING);
    });
    it('keeps the warning for an unlisted path with the same base name', () => {
      const d = {
        ...draft(`${WELL_DESC} See /tmp/x/artifacts/other/a.html for the layout.`),
        attachments: [{ path: 'proto/a.html' }],
      };
      expect(draftQualityWarnings(d)).toContain(LEAK_WARNING);
    });
    it('keeps the warning for a longer unlisted path that starts like a listed one', () => {
      for (const cite of ['$KARST_ARTIFACTS/proto/a.html.bak', '$KARST_ARTIFACTS/proto/a.html/x.md', '${KARST_ARTIFACTS}/proto/a.htmlx']) {
        const d = { ...draft(`${WELL_DESC} See ${cite} for the layout.`), attachments: [{ path: 'proto/a.html' }] };
        expect(draftQualityWarnings(d), cite).toContain(LEAK_WARNING);
      }
    });
    it('still accepts a listed cite that ends a sentence', () => {
      const d = { ...draft(`${WELL_DESC} The layout is in $KARST_ARTIFACTS/proto/a.html.`), attachments: [{ path: 'proto/a.html' }] };
      expect(draftQualityWarnings(d)).not.toContain(LEAK_WARNING);
    });
    it('uses the attachments wording', () => {
      expect(LEAK_WARNING).toBe('plan path not in attachments (attach or inline)');
    });
    it.each(['docs/artifacts/spec.md', 'src/artifacts/x.ts', '.codex/config.toml', 'my.claude/plans/x'])('does not flag %s', (ok) => {
      expect(draftQualityWarnings(draft(`${WELL_DESC} ${ok}`))).not.toContain(LEAK_WARNING);
    });
  });

  describe('thin description', () => {
    it('warns below 120 chars, not at 120', () => {
      expect(draftQualityWarnings(draft(pad(CORE, 119)))).toContain('description is short (119 chars)');
      expect(draftQualityWarnings(draft(pad(CORE, 120))).some((w) => w.startsWith('description is short'))).toBe(false);
    });
  });

  describe('dropped plan artifact', () => {
    const noVerify = 'Edit src/auth/session.ts.';
    it('needs hasPlanArtifact', () => {
      expect(draftQualityWarnings(draft(pad(CORE, 299)))).not.toContain(DROPPED_PLAN_WARNING);
    });
    it('warns below 300 chars, not at 300 when the draft has paths and verification', () => {
      expect(draftQualityWarnings(draft(pad(CORE, 299)), { hasPlanArtifact: true })).toContain(DROPPED_PLAN_WARNING);
      expect(draftQualityWarnings(draft(pad(CORE, 300)), { hasPlanArtifact: true })).not.toContain(DROPPED_PLAN_WARNING);
    });
    it('warns below 500 chars without verification or without paths, not at 500', () => {
      expect(draftQualityWarnings(draft(pad(noVerify, 499)), { hasPlanArtifact: true })).toContain(DROPPED_PLAN_WARNING);
      expect(draftQualityWarnings(draft(pad('Verify with vitest.', 499)), { hasPlanArtifact: true })).toContain(DROPPED_PLAN_WARNING);
      expect(draftQualityWarnings(draft(pad(CORE, 499)), { hasPlanArtifact: true })).not.toContain(DROPPED_PLAN_WARNING);
      expect(draftQualityWarnings(draft(pad(noVerify, 500)), { hasPlanArtifact: true })).not.toContain(DROPPED_PLAN_WARNING);
    });
    it('does not stack on a thin description', () => {
      const w = draftQualityWarnings(draft(pad(CORE, 100)), { hasPlanArtifact: true });
      expect(w).toContain('description is short (100 chars)');
      expect(w).not.toContain(DROPPED_PLAN_WARNING);
    });
  });

  describe('inverted description and summary', () => {
    it('P73 Step 213: the plan sits in the summary', () => {
      const description = pad('Return the host warnings to the planner so that it can revise its draft before the review.', 160);
      const summary = [
        '1. Edit src/cli/draftCommand.ts to poll the index until checking clears.',
        '2. Edit src/extension/ops/planningOutbox.ts to write one rejection file per uuid.',
        '3. Add tests in src/cli/draftCommand.test.ts and run npx vitest run.',
        '4. Update docs/arch/cli.md and run npm run -s docs:check.',
      ].join('\n');
      expect(draftQualityWarnings(draft(description, summary))).toContain(INVERTED_WARNING);
    });
    it('branch 1: a longer summary (> 1.5x) and a description with no path', () => {
      const description = pad('Verify with vitest.', 200);
      expect(draftQualityWarnings(draft(description, pad('Long summary.', 301)))).toContain(INVERTED_WARNING);
      expect(draftQualityWarnings(draft(description, pad('Long summary.', 300)))).not.toContain(INVERTED_WARNING);
    });
    it('branch 1: numbered steps in the summary only, even when the description has a path', () => {
      const steps = pad('1. one\n2. two\n', 301);
      expect(draftQualityWarnings(draft(WELL_DESC, steps))).toContain(INVERTED_WARNING);
      expect(draftQualityWarnings(draft(`${WELL_DESC}\n1. a\n2. b`, steps))).not.toContain(INVERTED_WARNING);
      expect(draftQualityWarnings(draft(WELL_DESC, pad('1. one only', 301)))).not.toContain(INVERTED_WARNING);
      expect(draftQualityWarnings(draft(WELL_DESC, pad('Step 1 one\nStep 2 two', 301)))).toContain(INVERTED_WARNING);
    });
    it('branch 1: only while the description is below 1000 chars', () => {
      const d999 = pad('Verify with vitest.', 999);
      const d1000 = pad('Verify with vitest.', 1000);
      expect(draftQualityWarnings(draft(d999, pad('s', 1499)))).toContain(INVERTED_WARNING);
      expect(draftQualityWarnings(draft(d1000, pad('s', 1501)))).not.toContain(INVERTED_WARNING);
    });
    it('branch 2: two paths in the summary and none in the description', () => {
      const description = pad('Verify with vitest.', 200);
      expect(draftQualityWarnings(draft(description, pad('Edit src/a.ts and src/b.ts.', 120)))).toContain(INVERTED_WARNING);
      expect(draftQualityWarnings(draft(description, pad('Edit src/a.ts only.', 120)))).not.toContain(INVERTED_WARNING);
      expect(draftQualityWarnings(draft(pad('Verify with vitest.', 1000), pad('Edit src/a.ts and src/b.ts.', 120)))).not.toContain(INVERTED_WARNING);
    });
  });

  describe('duplicate description and summary', () => {
    it('P73 Step 226: the same body twice', () => {
      const body = pad(`${CORE}\n${line(1)}\n${line(2)}\n${line(3)}`, 520);
      expect(draftQualityWarnings(draft(body, body))).toContain(DUPLICATE_WARNING);
    });
    it('an exact match after normalization, at any length', () => {
      expect(draftQualityWarnings(draft(WELL_DESC, `  ${WELL_DESC.toUpperCase()}  `))).toContain(DUPLICATE_WARNING);
    });
    it('containment needs both texts at 400 chars or more', () => {
      const d400 = pad(CORE, 400);
      expect(draftQualityWarnings(draft(d400, `${d400} more words here`))).toContain(DUPLICATE_WARNING);
      const d399 = pad(CORE, 399);
      expect(draftQualityWarnings(draft(d399, `${d399} more words here`))).not.toContain(DUPLICATE_WARNING);
    });
    it('line Jaccard at 0.75 or more warns, below does not', () => {
      const description = `${CORE}\n${line(1)}\n${line(2)}\n${line(3)}`;
      // {CORE, L1, L2, L3} vs {L3, L2, L1, CORE, L9}: 4/5 = 0.8
      expect(draftQualityWarnings(draft(description, `${line(3)}\n${line(2)}\n${line(1)}\n${CORE}\n${line(9)}`))).toContain(DUPLICATE_WARNING);
      // {CORE, L1, L2, L3} vs {L3, L2, L1, L9}: 3/5 = 0.6
      expect(draftQualityWarnings(draft(description, `${line(3)}\n${line(2)}\n${line(1)}\n${line(9)}`))).not.toContain(DUPLICATE_WARNING);
    });
    it('line Jaccard of exactly 0.75 warns', () => {
      const big = (k: number) => `${line(k)} ${line(k + 50)}`;
      const description = `${big(1)}\n${big(2)}\n${big(3)}\n${CORE}`;
      const summary = `${big(3)}\n${big(2)}\n${big(1)}`;
      // {B1, B2, B3, CORE} vs {B3, B2, B1}: 3/4 = 0.75 (both over 400 chars)
      expect(draftQualityWarnings(draft(description, summary))).toContain(DUPLICATE_WARNING);
    });
    it('4-word shingle Jaccard catches a reflowed copy', () => {
      const words = Array.from({ length: 90 }, (_, i) => `word${i}`);
      const description = `${CORE}\n${words.join(' ')}`;
      const summary = words.slice(0, 60).join('\n') + ' ' + words.slice(60).join(' ') + ` ${CORE}`;
      expect(draftQualityWarnings(draft(description, summary))).toContain(DUPLICATE_WARNING);
    });
    it('does not stack on an inverted draft', () => {
      const description = pad('Verify with vitest.', 400);
      const w = draftQualityWarnings(draft(description, `${description} ${'q'.repeat(300)}`));
      expect(w).toContain(INVERTED_WARNING);
      expect(w).not.toContain(DUPLICATE_WARNING);
    });
  });

  describe('thin summary', () => {
    it('warns below 80 chars, not at 80', () => {
      expect(draftQualityWarnings(draft(WELL_DESC, pad('Short.', 79)))).toContain('summary is short (79 chars)');
      expect(draftQualityWarnings(draft(WELL_DESC, pad('Short.', 80))).some((w) => w.startsWith('summary is short'))).toBe(false);
    });
  });

  describe('missing paths and verification', () => {
    const noPath = pad('Verify with vitest.', 200);
    const noVerify = pad('Edit src/auth/session.ts.', 200);
    it('warns on no path and on no verification for a draft with repos', () => {
      expect(draftQualityWarnings(draft(noPath))).toContain(NO_PATHS_WARNING);
      expect(draftQualityWarnings(draft(noVerify))).toContain(NO_VERIFICATION_WARNING);
    });
    it('a root config file counts as a path', () => {
      expect(draftQualityWarnings(draft(pad('Edit package.json. Verify with vitest.', 200)))).not.toContain(NO_PATHS_WARNING);
    });
    it('stays silent for a draft with no repos', () => {
      const w = draftQualityWarnings(draft(pad('Research spike only.', 200), WELL_SUM, []));
      expect(w).not.toContain(NO_PATHS_WARNING);
      expect(w).not.toContain(NO_VERIFICATION_WARNING);
    });
    it.each(['test', 'tests', 'vitest', 'jest', 'pytest', 'playwright', 'spec', 'verify', 'verification', 'assert', 'acceptance', 'done when', 'typecheck', 'gate', 'lint', 'build', 'compile', 'confirm', 'reproduce', 'smoke'])(
      'accepts "%s" as verification',
      (word) => {
        expect(draftQualityWarnings(draft(pad(`Edit src/a.ts. ${word.toUpperCase()} it.`, 200)))).not.toContain(NO_VERIFICATION_WARNING);
      },
    );
    it('does not match a verification word inside another word', () => {
      expect(draftQualityWarnings(draft(pad('Edit src/a.ts. Contested rebuilding.', 200)))).toContain(NO_VERIFICATION_WARNING);
    });
    it('skips both on a thin description and on an inverted draft', () => {
      const thin = draftQualityWarnings(draft(pad('Short.', 100)));
      expect(thin).not.toContain(NO_PATHS_WARNING);
      expect(thin).not.toContain(NO_VERIFICATION_WARNING);
      const inverted = draftQualityWarnings(draft(pad('Short text.', 200), pad('Edit src/a.ts and src/b.ts.', 400)));
      expect(inverted).toContain(INVERTED_WARNING);
      expect(inverted).not.toContain(NO_PATHS_WARNING);
      expect(inverted).not.toContain(NO_VERIFICATION_WARNING);
    });
    it('skips the path warning, not the verification warning, when the plan artifact was dropped', () => {
      const w = draftQualityWarnings(draft(pad('Short text.', 200)), { hasPlanArtifact: true });
      expect(w).toContain(DROPPED_PLAN_WARNING);
      expect(w).not.toContain(NO_PATHS_WARNING);
      expect(w).toContain(NO_VERIFICATION_WARNING);
    });
  });

  describe('oversized description', () => {
    it('warns above 12000 chars, not at 12000', () => {
      expect(draftQualityWarnings(draft(pad(CORE, 12_001)))).toContain('description is very large (12001 chars; split draft)');
      expect(draftQualityWarnings(draft(pad(CORE, 12_000))).some((w) => w.startsWith('description is very large'))).toBe(false);
    });
  });

  it('every warning is at most 60 chars', () => {
    const worst = draftQualityWarnings(
      { description: `${'x'.repeat(32 * 1024 - 40)} ~/.claude/plans/p.md`, summary: 's', repos: ['api'] },
      { hasPlanArtifact: true },
    );
    const thin = draftQualityWarnings({ description: 'd', summary: 's', repos: ['api'] }, { hasPlanArtifact: true });
    for (const w of [...worst, ...thin, LEAK_WARNING, DROPPED_PLAN_WARNING, INVERTED_WARNING, DUPLICATE_WARNING, NO_PATHS_WARNING, NO_VERIFICATION_WARNING]) {
      expect(w.length, w).toBeLessThanOrEqual(MAX_WARNING_CHARS);
    }
  });
});

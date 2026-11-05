import { describe, it, expect } from 'vitest';
import { resolveAdapter } from './registry.js';
import { IMPLEMENTED_PROVIDERS } from './provider.js';
import { structuredOutputFormOf, type StructuredOutputForm } from './surfaces.js';
import { outputRulesBase, OUTPUT_RULES_BASE } from './promptText.js';
import { buildAlignmentPrompt } from '../workflow/artifacts/alignment.js';
import { buildFindingsPrompt } from '../workflow/review/findingsLane.js';
import { buildTesterPrompt } from '../workflow/uat/tester.js';
import { parseFindingsResult } from '../workflow/review/findings.js';

const TOOL = '- Finish by calling the StructuredOutput tool with your findings in its `findings` array. Write no findings as text.';
const DOC =
  '- Your final message is ONLY a JSON object with one key, `findings`, whose value is the array of findings: no preamble, no markdown fence, no commentary.';
const NONE = '- Output ONLY a JSON array, nothing else: no preamble, no markdown fence, no commentary.';
const FIRST: Record<string, string> = { tool: TOOL, 'final-document': DOC, none: NONE };

const target = { repo: 'r', worktreePath: '/w', baseRef: 'main' };
const BUILDERS: Record<string, (form: StructuredOutputForm | undefined, custom?: boolean) => string> = {
  review: (form, custom) =>
    buildFindingsPrompt('r', 'main', 'b', custom ? 'Custom profile body.' : undefined, undefined, null, '/w', undefined, undefined, undefined, form),
  tester: (form, custom) => buildTesterPrompt(target, custom ? 'Custom profile body.' : undefined, null, { outputForm: form }),
  alignment: (form) => buildAlignmentPrompt('intent-spec', 'p', 'c', undefined, form),
};

describe('findings output rules per structured-output form', () => {
  it('resolves the five cores to the expected form', () => {
    const forms = Object.fromEntries(
      IMPLEMENTED_PROVIDERS.map((p) => [p, structuredOutputFormOf(resolveAdapter(p))]),
    );
    expect(forms).toMatchObject({ claude: 'tool', codex: 'final-document' });
    for (const p of ['antigravity', 'opencode', 'opencode2']) expect(forms[p]).toBeUndefined();
  });

  it('keeps the exported base rules equal to the none form', () => {
    expect(OUTPUT_RULES_BASE).toEqual(outputRulesBase(undefined));
  });

  for (const [name, build] of Object.entries(BUILDERS)) {
    for (const form of ['tool', 'final-document', undefined] as const) {
      const key = form ?? 'none';
      it(`${name}: ${key} form states the matching first rule only`, () => {
        const prompt = build(form);
        expect(prompt).toContain(FIRST[key]);
        for (const other of Object.keys(FIRST)) if (other !== key) expect(prompt).not.toContain(FIRST[other]!);
      });
      it(`${name}: ${key} form keeps the floor rules under a custom profile body`, () => {
        if (name === 'alignment') return; // no profile body on this builder
        const prompt = build(form, true);
        expect(prompt).toContain('Custom profile body.');
        expect(prompt).toContain(FIRST[key]);
      });
    }
    it(`${name}: tail line does not demand bare-array output on tool/final-document`, () => {
      for (const form of ['tool', 'final-document'] as const) {
        const prompt = build(form);
        expect(prompt).not.toMatch(/output exactly \[\]/);
        expect(prompt).not.toContain('output only the coverage entry');
      }
    });
  }

  it('the parser accepts the bare array and the findings container', () => {
    const f = [{ severity: 'low', title: 't', detail: 'd' }];
    const ctx = { repo: 'r', worktreePath: '/w', max: 10 };
    const quiet = (): void => {};
    expect(parseFindingsResult(JSON.stringify(f), ctx, quiet).findings).toHaveLength(1);
    expect(parseFindingsResult(JSON.stringify({ findings: f }), ctx, quiet).findings).toHaveLength(1);
  });
});

import { describe, it, expect } from 'vitest';
import { renderBehaviorDiagram, BEHAVIOR_NOTE } from './prVisuals.js';

let ready: Promise<{ parse: (code: string) => Promise<unknown> }> | undefined;
/** Same method as scripts/docsMermaid.mjs: mermaid.parse under jsdom. */
async function parseMermaid(code: string): Promise<void> {
  ready ??= (async () => {
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
    Object.assign(globalThis, { window: dom.window, document: dom.window.document });
    const mermaid = (await import('mermaid')).default;
    mermaid.initialize({ startOnLoad: false, logLevel: 'fatal', securityLevel: 'loose' });
    return mermaid;
  })();
  await (await ready).parse(code);
}

function fenceCode(section: string): string {
  const m = /```mermaid\n([\s\S]*?)\n```/u.exec(section);
  if (!m) throw new Error('no mermaid fence');
  return m[1]!;
}

const valid = {
  before: [{ label: 'Agent writes markdown' }, { label: 'Sanitizer trims it', kind: 'bad' }],
  after: [{ label: 'Agent returns JSON' }, { label: 'Code renders body', kind: 'ok' }],
};

describe('renderBehaviorDiagram', () => {
  it('builds one mermaid fence with Before and After subgraphs and the note', () => {
    const out = renderBehaviorDiagram(valid)!;
    expect(out.startsWith('## Behavior\n\n```mermaid\nflowchart LR\n')).toBe(true);
    expect(out.match(/```mermaid/gu)).toHaveLength(1);
    expect(out).toContain('subgraph before["Before"]');
    expect(out).toContain('subgraph after["After"]');
    expect(out).toContain('b1["Agent writes markdown"] --> b2["Sanitizer trims it"]');
    expect(out).toContain('a1["Agent returns JSON"] --> a2["Code renders body"]');
    expect(out).toContain('classDef bad stroke:#cf222e');
    expect(out).toContain('classDef ok stroke:#1a7f37');
    expect(out).toContain('class b2 bad');
    expect(out).toContain('class a2 ok');
    expect(out.trimEnd().endsWith(BEHAVIOR_NOTE)).toBe(true);
    expect(BEHAVIOR_NOTE).toBe('<sub>Drawn by the agent from the diff.</sub>');
  });

  it('writes a class line only for a kind that is used', () => {
    const out = renderBehaviorDiagram({ before: [{ label: 'A' }], after: [{ label: 'B' }] })!;
    expect(out).not.toContain('classDef');
    expect(out).not.toMatch(/^\s*class /mu);
  });

  it('draws a single-step side without an arrow', () => {
    const out = renderBehaviorDiagram({ before: [{ label: 'A' }], after: [{ label: 'B' }] })!;
    expect(out).toContain('b1["A"]');
    expect(out).not.toContain('-->');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'graph TD'],
    ['an array', []],
    ['missing after', { before: [{ label: 'A' }] }],
    ['empty before', { before: [], after: [{ label: 'A' }] }],
    ['empty after', { before: [{ label: 'A' }], after: [] }],
    ['7 steps', { before: Array.from({ length: 7 }, () => ({ label: 'x' })), after: [{ label: 'A' }] }],
    ['blank label', { before: [{ label: '  ' }], after: [{ label: 'A' }] }],
    ['non-string label', { before: [{ label: 3 }], after: [{ label: 'A' }] }],
    ['step not an object', { before: ['A'], after: [{ label: 'A' }] }],
    ['bad kind', { before: [{ label: 'A', kind: 'meh' }], after: [{ label: 'A' }] }],
  ])('returns null for %s', (_n, value) => {
    expect(renderBehaviorDiagram(value)).toBeNull();
  });

  it('writes a debug line for a broken rule but none for null or missing', () => {
    const lines: string[] = [];
    const debug = (m: string): void => void lines.push(m);
    renderBehaviorDiagram(null, debug);
    renderBehaviorDiagram(undefined, debug);
    expect(lines).toEqual([]);
    renderBehaviorDiagram({ before: [], after: [] }, debug);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[ship\] .*behavior/u);
  });

  it('treats a null kind as no kind', () => {
    const out = renderBehaviorDiagram({ before: [{ label: 'A', kind: null }], after: [{ label: 'B' }] });
    expect(out).toContain('b1["A"]');
    expect(out).not.toContain('classDef');
  });

  it('accepts exactly 6 steps a side', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ label: `s${i}` }));
    const out = renderBehaviorDiagram({ before: six, after: six })!;
    expect(out).toContain('b6["s5"]');
    expect(out).toContain('a6["s5"]');
  });

  it('cleans, caps and encodes a label', () => {
    const out = renderBehaviorDiagram({
      before: [{ label: '  a\n\tb\u0000  c  ' }],
      after: [{ label: 'x'.repeat(80) }],
    })!;
    expect(out).toContain('b1["a b c"]');
    expect(out).toContain(`a1["${'x'.repeat(60)}#8230;"]`);
  });

  it('encodes every special character as a decimal entity', () => {
    const out = renderBehaviorDiagram({
      before: [{ label: '"[]()|<>#;`@' }],
      after: [{ label: 'ok' }],
    })!;
    expect(out).toContain('b1["#34;#91;#93;#40;#41;#124;#60;#62;#35;#59;#96;#64;"]');
  });

  it('never leaks @arch: or a fence closer from a label', () => {
    const out = renderBehaviorDiagram({
      before: [{ label: '@arch:X' }],
      after: [{ label: '```\n## pwn' }],
    })!;
    expect(out).not.toContain('@arch:');
    expect(out.match(/```/gu)).toHaveLength(2);
  });

  it('passes mermaid.parse, with every special character in a label', async () => {
    const special = '"[]()|<>#;`@ & \' { } \\ % * ~ ! ? $ ^ é 漢 😀';
    const outputs = [
      renderBehaviorDiagram(valid)!,
      renderBehaviorDiagram({
        before: [{ label: special, kind: 'bad' }, { label: special }],
        after: [{ label: special, kind: 'ok' }],
      })!,
      renderBehaviorDiagram({
        before: [{ label: 'A' }],
        after: [{ label: 'B', kind: 'ok' }, { label: 'C', kind: 'bad' }],
      })!,
    ];
    for (const o of outputs) await parseMermaid(fenceCode(o));
  }, 60_000);
});

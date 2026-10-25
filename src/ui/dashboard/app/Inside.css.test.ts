/**
 * Source-text guards for the Inside rules that moved out of webview.html with the markup (`Inside.css`,
 * `InsideEvidence.css`, `InsideShipPreview.css`, `InsideResponsive.css`).
 *
 * Be honest about what these are: a text assertion CANNOT catch a visual regression. It cannot tell you a row wraps
 * or the spine drifts, only that the rule which stops that is still in the file. Each exists so the fix cannot be
 * quietly deleted by someone tidying the CSS. Re-verifying the pixels needs the visual sweep (`npm run -s test:visual:docker`).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** A literal selector as a RegExp source: every metacharacter escaped, the backslash included. */
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const read = (name: string): string => readFileSync(join(HERE, name), 'utf8');
/** In import order, which is the order the rules cascade in. */
const CSS = ['Inside.css', 'InsideEvidence.css', 'InsideShipPreview.css', 'InsideResponsive.css'].map(read).join('\n');
const PAGE = readFileSync(join(HERE, '..', 'webview.html'), 'utf8');
const INSIDE_TSX = read('Inside.tsx');

/** One brace-balanced `@container (max-width: <w>)` block. */
function containerBlock(w: string): string {
  const at = CSS.indexOf(`@container (max-width: ${w}){`);
  expect(at, `missing @container (max-width: ${w})`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = CSS.indexOf('{', at); i < CSS.length; i += 1) {
    if (CSS[i] === '{') depth += 1;
    else if (CSS[i] === '}') {
      depth -= 1;
      if (depth === 0) return CSS.slice(at, i + 1);
    }
  }
  throw new Error(`unbalanced @container (max-width: ${w})`);
}

describe('Inside CSS — where it lives', () => {
  it('imports the four files in cascade order, the responsive overrides last', () => {
    const imports = [...INSIDE_TSX.matchAll(/import '\.\/(Inside[A-Za-z]*\.css)'/g)].map((m) => m[1]);
    expect(imports).toEqual(['Inside.css', 'InsideEvidence.css', 'InsideShipPreview.css', 'InsideResponsive.css']);
  });

  it('leaves no #inside rule in the page stylesheet', () => {
    const styles = [...PAGE.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]!.replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');
    expect(styles).not.toContain('#inside');
  });

  it('scopes every rule under #inside, so nothing here can reach the rail, the panels or another webview', () => {
    const selectors = [...CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|\})\s*([^{}@]+)\{/g)].map((m) => m[1]!.trim());
    const loose = selectors.filter((s) => s.split(',').some((part) => !part.trim().startsWith('#inside')));
    expect(loose).toEqual([]);
  });

  it('writes no colour literal: the palette is the --p-* custom properties over the same --k-* tokens', () => {
    const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/);
  });
});

describe('Inside CSS — the ledger grid and the evidence cells', () => {
  it('keeps the ledger rows wrappable at narrow widths (UI-R04/R05)', () => {
    // The process summary is a GRID whose content column is minmax(0,1fr) and every evidence row is a grid too, so
    // 300px never scrolls the component horizontally: only the glyph column is fixed.
    expect(CSS).toMatch(/#inside \.op summary,#inside \.op-static\{[\s\S]*?minmax\(0,1fr\)/);
    expect(CSS).toMatch(/#inside \.evidence-row\{display:grid[^}]*minmax\(0,1fr\)/);
    // The detail cell is a pure grid item (min-width:0 lets it shrink to its ellipsis), never a fixed or minimum width.
    expect(CSS).toMatch(/#inside \.op-detail\.detail-console \.op-detail-text\{[\s\S]*?min-width:0/);
    const detail = CSS.slice(CSS.indexOf('#inside .op-detail{'), CSS.indexOf('#inside .op-detail{') + 240);
    expect(detail).toContain('min-width:0');
    expect(detail).not.toContain('overflow-x');
  });

  it('positions the row status glyph in its own leading cell, not the tail', () => {
    expect(CSS).toMatch(/#inside \.ev-glyph\{[^}]*justify-content:center/);
    expect(CSS).toMatch(/#inside \.ev-state\{[^}]*justify-content:flex-end/);
    expect(CSS).toMatch(/#inside \.gate-state\{[^}]*justify-content:flex-end/);
  });

  it('gives gate rows, evidence rows and recovery rounds a leading fixed track for the glyph', () => {
    expect(CSS).toMatch(/#inside \.gate-row\{display:grid;grid-template-columns:18px minmax\(74px,90px\) minmax\(110px,150px\) minmax\(0,1fr\) auto;/);
    expect(CSS).toMatch(/#inside \.gates\.no-repo \.gate-row\{grid-template-columns:18px minmax\(110px,150px\) minmax\(0,1fr\) auto\}/);
    expect(CSS).toMatch(/#inside \.evidence-row\{display:grid;grid-template-columns:18px minmax\(74px,100px\) minmax\(0,1fr\) auto;/);
    expect(CSS).toMatch(/#inside \.recovery-round\{display:grid;grid-template-columns:18px 56px minmax\(0,1fr\) auto;/);
  });

  it('has a rule for every container the evidence bodies emit', () => {
    for (const cls of ['gates', 'findings', 'session-segments', 'recovery-history', 'done-line', 'evidence-row', 'commit-grid', 'pr-branches', 'graph-nodes', 'graph-dag', 'receipt-grid', 'overflow-note']) {
      expect(CSS, `no rule for .${cls}`).toContain(`#inside .${cls}`);
    }
  });

  it('keeps the graph entries separated by a border that the last one drops', () => {
    expect(CSS).toMatch(/#inside \.graph-entry:last-child\{border-bottom:0\}/);
    expect(CSS).not.toMatch(/#inside \.graph-node:last-child/);
  });

  it('gives the process summary its own focus ring and a rotating marker (B3)', () => {
    // <summary> is neither a <button> nor an <a>/<input>, so the primitives' generic :focus-visible rule never reaches it (UI-R23).
    expect(CSS).toMatch(/#inside \.op summary:focus-visible\{outline:var\(--k-focus-w\) solid var\(--k-focus\)/);
    expect(CSS).toMatch(/#inside \.op\[open\] \.chev:before\{transform:rotate\(45deg\)\}/);
  });

  it('keeps the timeline rail geometry centered on the status glyph column', () => {
    // The rail has ONE source of truth for its x-position: the slot cell. The node and both edge halves are centered
    // on 50% of that same cell, so the spine cannot drift off the nodes at any width.
    expect(CSS).toMatch(/#inside \.timeline-slot\{[^}]*width:var\(--timeline-col\)/);
    expect(CSS).toMatch(/#inside \.timeline-slot:before,#inside \.timeline-slot:after\{[^}]*left:50%/);
    expect(CSS).toMatch(/#inside \.timeline-slot:before\{top:0;height:calc\(50% - var\(--node-radius, 7px\)\)\}/);
    expect(CSS).toMatch(/#inside \.timeline-slot:after\{top:calc\(50% \+ var\(--node-radius, 7px\)\);bottom:0\}/);
    expect(CSS).toMatch(/#inside \.timeline-row:first-child \.timeline-slot:before,\s*#inside \.timeline-row:last-child \.timeline-slot:after\{display:none\}/);
  });
});

describe('Inside CSS — the container queries', () => {
  it('makes the inside block its own query container (B7), with no overflow-x on its root', () => {
    // The responsive rules are CONTAINER queries on #inside itself, so they follow the panel's real width.
    const root = /#inside\{[^}]*\}/.exec(CSS)?.[0] ?? '';
    expect(root, '#inside container declaration lost').toContain('container-type:inline-size');
    expect(root).not.toContain('overflow-x');
  });

  it('covers the handoff breakpoints 300/360/430 with ledger rules (B7)', () => {
    // ≤430: both the process detail and the evidence detail wrap instead of ellipsising to nothing (the §3.9 finding).
    const wide = containerBlock('430px');
    expect(wide).toMatch(/#inside \.op summary,#inside \.op-static\{grid-template-columns:20px minmax\(68px,86px\)/);
    expect(wide).toMatch(/#inside \.finding-title,#inside \.ev-detail,#inside \.done-copy,#inside \.op-detail\{/);
    // The glyph track leads even at 430px: the repo column is what drops, never the status. Four rendered children need four named tracks.
    expect(wide).toMatch(/#inside \.gate-row\{grid-template-columns:18px 70px minmax\(0,1fr\) auto\}/);
    expect(wide).toMatch(/#inside \.evidence-row\{grid-template-columns:18px minmax\(60px,80px\) minmax\(0,1fr\) auto\}/);
    // The pins that used to paper over a missing fourth track must not come back.
    expect(wide).not.toMatch(/#inside \.gate-state\{grid-column/);
    expect(wide).not.toMatch(/#inside \.ev-state\{grid-column/);
    // The timeline keeps node/edge alignment (§10).
    expect(wide).toMatch(/#inside \.timeline-row\{grid-template-columns:var\(--timeline-col\) minmax\(82px,104px\)/);
    // ≤360: the block's chrome thins; ≤300: the floor, only row chrome thins and nothing is dropped.
    expect(containerBlock('360px')).toMatch(/#inside \.op summary,#inside \.op-static\{/);
    expect(containerBlock('360px')).toMatch(/#inside \.evidence-row,#inside \.gate-row\{/);
    const floor = containerBlock('300px');
    expect(floor).toMatch(/#inside \.inside\{/);
    expect(floor).toMatch(/#inside \.op-body\{/);
    expect(floor).toMatch(/#inside \.evidence-row,#inside \.gate-row,#inside \.finding,#inside \.done-line\{/);
    expect(floor).not.toMatch(/display:none/);
  });

  it('never introduces whole-component horizontal scrolling at the breakpoints (B7)', () => {
    for (const w of ['300px', '360px', '430px']) {
      expect(containerBlock(w), `@container (max-width: ${w}) scrolls horizontally`).not.toMatch(/overflow-x:\s*(?:scroll|auto)/);
    }
  });

  it('keeps the glyph and the process name leading the op grid at every width (Task 6)', () => {
    expect(CSS).toMatch(/#inside \.op summary,#inside \.op-static\{[\s\S]*?grid-template-columns:20px minmax\(78px,110px\) minmax\(0,1fr\) auto 16px/);
    expect(containerBlock('430px')).toMatch(/#inside \.op summary,#inside \.op-static\{grid-template-columns:20px minmax\(68px,86px\) minmax\(0,1fr\) auto 16px[;}]/);
  });

  it('thins row chrome at ≤360 without dropping a cell (Task 6)', () => {
    const narrow = containerBlock('360px');
    expect(narrow).toMatch(/#inside \.op summary,#inside \.op-static\{[^}]*padding-left/);
    expect(narrow).not.toMatch(/display:none/);
  });

  it('never hides the name, status, identity, disclosure, or action at any narrow width (Task 6)', () => {
    // handoff §10: "Do not hide the only status or action." A narrow rule may RE-AREA a cell, never display:none it.
    for (const w of ['430px', '360px', '300px'] as const) {
      const block = containerBlock(w);
      for (const [sel, what] of [
        ['.op-name', 'the process name'],
        ['.glyph', 'the status glyph'],
        ['.agent-id', 'the identity run'],
        ['#inside .op-tail', 'the status/action cluster'],
        ['.ev-state', 'a row status'],
        ['.chev', 'the disclosure marker'],
        ['.timeline-slot', 'the timeline node cell'],
      ] as const) {
        // The cell ITSELF may never be hidden; hiding one part of its contents (the model name inside an identity run) is a legal degradation.
        expect(new RegExp(`${escapeRegExp(sel)}\\{[^}]*display:none`).exec(block), `≤${w} hides ${what}`).toBeNull();
      }
    }
  });

  it('wraps unbounded paths and branches mid-token, but never the compact cells (Task 6)', () => {
    // white-space:normal alone still cannot break an UNBROKEN token (a long branch name or SHA): overflow-wrap:anywhere does.
    expect(containerBlock('430px')).toMatch(/#inside \.finding-title,#inside \.ev-detail,#inside \.done-copy,#inside \.op-detail\{[\s\S]*?overflow-wrap:anywhere/);
    for (const [sel, label] of [
      ['#inside .phase-time', 'the timestamp'],
      ['#inside .duration', 'the duration'],
    ] as const) {
      const rule = new RegExp(`${escapeRegExp(sel)}[,{]([^}]*)\\}`).exec(CSS)?.[1] ?? '';
      expect(rule, `${label} cell lost its nowrap`).toContain('white-space:nowrap');
      expect(rule, `${label} cell must never claim a wrap point`).not.toContain('overflow-wrap');
    }
  });

  it('stacks the ship preview rows label-above-value below 700px (UI-R43), and keeps the page grid rule where it was', () => {
    expect(CSS).toMatch(/@media \(max-width: 699px\)\{\s*#inside \.sp-row\{grid-template-columns:minmax\(0,1fr\)/);
    expect(PAGE).toMatch(/@media \(max-width: 699px\)\{\s*\.grid\{grid-template-columns:1fr\}/);
  });

  it('stops the running glyph spinning under reduced motion without hiding it (UI-R30)', () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)\{\s*#inside \.glyph\.run:before\{animation:none\}/);
    expect(CSS).not.toMatch(/glyph\.run[^{]*\{[^}]*display:none/);
  });
});

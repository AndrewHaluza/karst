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

/** Every brace-balanced `@container (max-width: <w>)` block of that width, joined (a tier may be split in two). */
function containerBlock(w: string): string {
  const head = `@container (max-width: ${w}){`;
  const blocks: string[] = [];
  for (let at = CSS.indexOf(head); at > -1; at = CSS.indexOf(head, at + 1)) {
    let depth = 0;
    let end = -1;
    for (let i = CSS.indexOf('{', at); i < CSS.length; i += 1) {
      if (CSS[i] === '{') depth += 1;
      else if (CSS[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) throw new Error(`unbalanced @container (max-width: ${w})`);
    blocks.push(CSS.slice(at, end + 1));
  }
  expect(blocks.length, `missing @container (max-width: ${w})`).toBeGreaterThan(0);
  return blocks.join('\n');
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
    expect(CSS).toMatch(/#inside \.ev-state,#inside \.gate-state\{[^}]*justify-items:end/);
  });

  it('draws time and duration as two fixed, right-aligned, tabular columns from shared tokens (UI-R41)', () => {
    expect(CSS).toMatch(/#inside\{--inside-time-w:11ch;--inside-dur-w:7ch\}/);
    expect(CSS).toMatch(/#inside \.ev-state,#inside \.gate-state\{[^}]*grid-template-columns:var\(--inside-time-w\) var\(--inside-dur-w\)[^}]*font-variant-numeric:tabular-nums/);
    expect(CSS).toMatch(/#inside \.op-time\{[^}]*justify-content:flex-end;font-variant-numeric:tabular-nums/);
    expect(CSS).toMatch(/#inside \.duration\{[^}]*justify-content:flex-end;font-variant-numeric:tabular-nums/);
    expect(CSS).not.toContain('text-transform:lowercase;white-space:nowrap;\n  font-family');
  });

  it('gives gate rows and evidence rows a leading fixed track for the glyph', () => {
    expect(CSS).toMatch(/#inside \.gate-row\{display:grid;grid-template-columns:18px minmax\(74px,90px\) minmax\(110px,150px\) minmax\(0,1fr\) var\(--ev-timing-w\);/);
    expect(CSS).toMatch(/#inside \.gates\.no-repo \.gate-row\{grid-template-columns:18px minmax\(110px,150px\) minmax\(0,1fr\) var\(--ev-timing-w\)\}/);
    expect(CSS).toMatch(/#inside \.evidence-row\{display:grid;grid-template-columns:18px minmax\(74px,100px\) minmax\(0,1fr\) auto var\(--ev-timing-w\);/);
  });

  it('has a rule for every container the evidence bodies emit', () => {
    for (const cls of ['gates', 'findings', 'session-segments', 'done-line', 'evidence-row', 'commit-grid', 'pr-branches', 'graph-nodes', 'graph-dag', 'receipt-grid', 'overflow-note']) {
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

  it('covers the container tiers 999/699/399 and no ad-hoc breakpoint (RD-TIERS)', () => {
    const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const widths = [...rules.matchAll(/@container \(max-width: (\d+)px\)/g)].map((m) => m[1]);
    expect([...new Set(widths)].sort()).toEqual(['399', '699', '999']);
    // Mid: the model drops first, the core name stays.
    expect(containerBlock('999px')).toMatch(/#inside \.op-tail \.agent-model/);
    // Narrow: row one is glyph, name, detail, duration, chevron; the tail takes ONE second line.
    const narrow = containerBlock('699px');
    expect(narrow).toMatch(/#inside \.op summary,#inside \.op-static\{grid-template-columns:20px minmax\(78px,110px\) minmax\(0,1fr\) var\(--inside-dur-w\) 16px/);
    expect(narrow).toMatch(/#inside \.op summary>\.op-tail,#inside \.op-static>\.op-tail\{grid-column:2\/-1;grid-row:2/);
    // The glyph track leads: the repo column is what drops, never the status.
    expect(narrow).toMatch(/#inside \.gate-row\{grid-template-columns:18px 70px minmax\(0,1fr\) var\(--ev-timing-w\)\}/);
    expect(narrow).toMatch(/#inside \.evidence-row\{grid-template-columns:18px minmax\(60px,80px\) minmax\(0,1fr\) auto var\(--ev-timing-w\)\}/);
    expect(narrow).not.toMatch(/#inside \.gate-state\{grid-column/);
    expect(narrow).not.toMatch(/#inside \.ev-state\{grid-column/);
    expect(narrow).toMatch(/#inside \.timeline-row\{grid-template-columns:var\(--timeline-col\) minmax\(82px,104px\)/);
    // Tight: chrome thins and nothing is dropped from a row.
    const tight = containerBlock('399px');
    expect(tight).toMatch(/#inside \.op summary,#inside \.op-static\{/);
    expect(tight).toMatch(/#inside \.evidence-row,#inside \.gate-row\{/);
    expect(tight).toMatch(/#inside \.op-body\{/);
    expect(tight).toMatch(/#inside \.evidence-row,#inside \.gate-row,#inside \.finding,#inside \.done-line\{/);
  });

  it('never introduces whole-component horizontal scrolling at the tiers (B7)', () => {
    for (const w of ['999px', '699px', '399px']) {
      expect(containerBlock(w), `@container (max-width: ${w}) scrolls horizontally`).not.toMatch(/overflow-x:\s*(?:scroll|auto)/);
    }
  });

  it('keeps the glyph and the process name leading the op grid at every width (Task 6)', () => {
    expect(CSS).toMatch(/#inside \.op summary,#inside \.op-static\{[\s\S]*?grid-template-columns:20px minmax\(78px,110px\) minmax\(96px,1fr\) auto var\(--inside-time-w\) var\(--inside-dur-w\) 16px/);
    expect(containerBlock('699px')).toMatch(/#inside \.op summary,#inside \.op-static\{grid-template-columns:20px minmax\(78px,110px\) minmax\(0,1fr\) var\(--inside-dur-w\) 16px[;}]/);
  });

  it('thins row chrome at <=399 without dropping a cell (Task 6)', () => {
    const tight = containerBlock('399px');
    expect(tight).toMatch(/#inside \.op summary,#inside \.op-static\{[^}]*padding-left/);
    expect(tight).not.toMatch(/#inside \.op summary[^{]*\{[^}]*display:none/);
  });

  it('never hides the name, status, disclosure, or action at any narrow width (Task 6)', () => {
    // handoff §10: "Do not hide the only status or action." A narrow rule may RE-AREA a cell, never display:none it.
    // The identity run is the one legal degradation: its core name and model drop, the icon stays with an aria-label.
    for (const w of ['999px', '699px', '399px'] as const) {
      const block = containerBlock(w);
      for (const [sel, what] of [
        ['.op-name', 'the process name'],
        ['.glyph', 'the status glyph'],
        ['#inside .op-tail', 'the status/action cluster'],
        ['.ev-state', 'a row status'],
        ['.chev', 'the disclosure marker'],
        ['.timeline-slot', 'the timeline node cell'],
      ] as const) {
        expect(new RegExp(`${escapeRegExp(sel)}\\{[^}]*display:none`).exec(block), `≤${w} hides ${what}`).toBeNull();
      }
    }
    expect(containerBlock('399px')).toMatch(/#inside \.agent-id \.agent-core,#inside \.agent-id \.agent-sep,#inside \.agent-id \.agent-model\{display:none\}/);
  });

  it('wraps unbounded paths mid-token in the live line, but never the compact cells (Task 6)', () => {
    expect(containerBlock('399px')).toMatch(/#inside \.inside-live \*\{[^}]*overflow-wrap:anywhere/);
    for (const [sel, label] of [
      ['#inside .phase-time', 'the timestamp'],
      ['#inside .duration', 'the duration'],
    ] as const) {
      const rule = new RegExp(`${escapeRegExp(sel)}[,{]([^}]*)\\}`).exec(CSS)?.[1] ?? '';
      expect(rule, `${label} cell lost its nowrap`).toContain('white-space:nowrap');
      expect(rule, `${label} cell must never claim a wrap point`).not.toContain('overflow-wrap');
    }
  });

  it('stacks the ship preview rows label-above-value in the narrow tier (UI-R43), and keeps the page grid rule where it was', () => {
    expect(containerBlock('699px')).toMatch(/#inside \.sp-row\{grid-template-columns:minmax\(0,1fr\)/);
    expect(PAGE).toMatch(/@media \(max-width: 699px\)\{\s*\.grid\{grid-template-columns:1fr\}/);
  });

  it('stops the running glyph spinning under reduced motion without hiding it (UI-R30)', () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)\{\s*#inside \.glyph\.run:before\{animation:none\}/);
    expect(CSS).not.toMatch(/glyph\.run[^{]*\{[^}]*display:none/);
  });
});

describe('the thin round row', () => {
  const rule = (sel: string): string => new RegExp(`${escapeRegExp(sel)}\\s*\\{[^}]*\\}`).exec(CSS)?.[0] ?? '';
  it('wraps with visible overflow, so every round stays reachable, and underlines the selected tab', () => {
    expect(rule('#inside .attempt-tabs')).toContain('flex-wrap:wrap');
    expect(rule('#inside .attempt-tabs')).toContain('overflow:visible');
    expect(rule('#inside .attempt-tab[aria-selected="true"]')).toMatch(/box-shadow|border-bottom/);
  });
  it('drops the label and tail in the narrow tier', () => {
    const block = containerBlock('699px');
    expect(block).toContain('#inside .attempt-tabs-label');
    expect(block).toContain('#inside .attempt-tab-tail');
  });
});

describe('the status glyph marks sit at the ring center (T1014)', () => {
  const rule = (sel: string): string => new RegExp(`${escapeRegExp(sel)}\\s*\\{[^}]*\\}`).exec(CSS)?.[0] ?? '';
  // The ring content box is 14px (16px less the 1px border): an odd mark cannot sit on a whole pixel.
  it('draws the pending and note dot at an even 4px size', () => {
    const dot = rule('#inside .glyph.pending:before,#inside .glyph.note:before');
    expect(dot).toContain('width:4px;height:4px');
    expect(dot).not.toContain('3px');
  });
  it('draws the skip line at an even 8px x 2px size', () => {
    const line = rule('#inside .glyph.skip:before');
    expect(line).toContain('width:8px;height:2px');
    expect(line).not.toContain('7px');
  });
  it('shifts the pass check 0.5px left to cancel its horizontal offset', () => {
    expect(rule('#inside .glyph.pass:before')).toContain('translate(-0.5px,-1px) rotate(-45deg)');
  });
});

describe('the nested error-text disclosure (T1072)', () => {
  it("resets the row rule's grid so 'Show' stays one inline word", () => {
    const line = new RegExp(`${escapeRegExp('#inside .op .ev-output summary')}\\{([^}]*)\\}`).exec(CSS)?.[1] ?? '';
    expect(line).toContain('display:inline-block');
    expect(line).toContain('grid-template-columns:none');
    expect(line).toContain('white-space:nowrap');
  });
});

describe('the narrow Deliver row (T1072)', () => {
  it('gives the Deliver body its own timing vars in the narrow tier, where the tail takes the second line', () => {
    const narrow = containerBlock('699px');
    expect(narrow).toContain('#inside .inside,#inside .op-body{--inside-time-w:0px;--ev-timing-w:var(--inside-dur-w)}');
    expect(narrow).toMatch(/#inside \.op summary>\.op-tail,#inside \.op-static>\.op-tail\{grid-column:2\/-1;grid-row:2/);
  });
});

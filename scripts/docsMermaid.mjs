// Parse-check the ```mermaid fences in the reference docs. See docs/arch/README.md (@arch:DOC-01).
// CLI: node scripts/docsMermaid.mjs
//
// mermaid.parse() runs under jsdom (mermaid 11.17.2, the repo's jsdom) and
// validates the whole diagram, not just its first line: it parses flowchart,
// sequenceDiagram and erDiagram without a browser, so no smoke-only fallback is
// used. A fence that throws fails the run.
import { fileURLToPath } from 'node:url';
import { collectDocs } from './docsKeys.mjs';

/** Every ```mermaid fence in `text`: `{ line, code }`, line is 1-based. */
export function mermaidFences(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  let fence = null;
  let buf = null;
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence && m) {
      fence = m[1];
      start = i + 1;
      if (m[2].trim() === 'mermaid') buf = [];
      continue;
    }
    if (fence && m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) {
      if (buf) out.push({ line: start, code: buf.join('\n') });
      fence = null;
      buf = null;
      continue;
    }
    if (buf) buf.push(line);
  }
  return out;
}

let ready = null;
async function getMermaid() {
  if (!ready) {
    ready = (async () => {
      const { JSDOM } = await import('jsdom');
      const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
      globalThis.window = dom.window;
      globalThis.document = dom.window.document;
      const mermaid = (await import('mermaid')).default;
      mermaid.initialize({ startOnLoad: false, logLevel: 'fatal', securityLevel: 'loose' });
      return mermaid;
    })();
  }
  return ready;
}

/** Parses `code`, returning the first error line or `null` when it is valid. */
export async function parseMermaid(code) {
  const mermaid = await getMermaid();
  try {
    await mermaid.parse(code);
    return null;
  } catch (e) {
    return String(e?.message ?? e).split('\n')[0];
  }
}

/** Lint every mermaid fence of one doc; async because mermaid.parse is. */
export async function lintDocMermaid({ path, text }) {
  const out = [];
  for (const f of mermaidFences(text)) {
    const err = await parseMermaid(f.code);
    if (err) out.push(`${path}:${f.line}: mermaid: ${err}`);
  }
  return out;
}

async function main() {
  const docs = collectDocs();
  const out = [];
  for (const d of docs) out.push(...(await lintDocMermaid(d)));
  if (out.length) {
    console.error(out.join('\n'));
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

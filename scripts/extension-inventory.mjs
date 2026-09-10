#!/usr/bin/env node

/**
 * Generates an inventory of registerCommand handlers and direct children of
 * activate() in src/extension.ts. Two text passes — no TS compiler API.
 *
 * Usage: node scripts/extension-inventory.mjs > docs/arch/extension-inventory.md
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcPath = resolve(__dirname, '..', 'src', 'extension.ts');
const outPath = resolve(__dirname, '..', 'docs', 'arch', 'extension-inventory.md');

const src = readFileSync(srcPath, 'utf-8');
const lines = src.split('\n');

// ---------------------------------------------------------------------------
// Depth scanner: given a start line (0-indexed), find the line where the
// brace/paren/bracket depth returns to 0.  Handles nested delimiters, string
// literals (single/double), and template literals (backtick) with escape
// handling.
//
// For registerCommand( calls the first `(` sets depth to 1 and the matching
// `)` returns it to 0.  For function declarations with `{` on the same line,
// pass startFromBrace=true to skip past the parameter-list parens and begin
// counting from the function body's opening `{` (depth starts at 1).
// ---------------------------------------------------------------------------

function findBodyEnd(startLine, { startFromBrace = false } = {}) {
  let depth = 0;
  let inString = null; // null | "'" | '"' | '`'
  let inBlockComment = false;
  let escaped = false;
  let started = !startFromBrace;
  let prevNonSpace = ''; // last non-whitespace char seen (for regex detection)

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      const next = c + 1 < line.length ? line[c + 1] : '';

      if (escaped) { escaped = false; prevNonSpace = ch; continue; }

      // Block comment handling
      if (inBlockComment) {
        if (ch === '*' && next === '/') { inBlockComment = false; c++; prevNonSpace = ''; }
        continue;
      }

      // Skip single-line comments
      if (ch === '/' && next === '/') break;
      if (ch === '/' && next === '*') { inBlockComment = true; c++; prevNonSpace = ''; continue; }

      // Regex literal detection: a `/` starts a regex if preceded by an
      // operator, `(`, `[`, `{`, `,`, `=`, `;`, or certain keywords.
      if (ch === '/' && next !== '/' && next !== '*') {
        if (prevNonSpace === '' || '=(!&|?:,;[{'.includes(prevNonSpace)) {
          // This is a regex literal — skip to the closing /
          c++; // skip opening /
          while (c < line.length) {
            const rc = line[c];
            if (rc === '\\') { c++; continue; } // skip escaped char
            if (rc === '/') break;
            c++;
          }
          // Skip regex flags
          c++;
          while (c < line.length && /[gimsuy]/.test(line[c] || '')) c++;
          prevNonSpace = '/';
          continue;
        }
      }

      if (ch === '\\') { escaped = true; prevNonSpace = ch; continue; }

      if (inString) {
        if (ch === inString) inString = null;
        prevNonSpace = ch;
        continue;
      }

      if (ch === "'" || ch === '"' || ch === '`') { inString = ch; prevNonSpace = ch; continue; }

      if (ch === '(' || ch === '{' || ch === '[') {
        if (!started) {
          if (ch === '{') { started = true; depth = 1; }
          prevNonSpace = ch;
          continue;
        }
        depth++;
        prevNonSpace = ch;
        continue;
      }
      if (ch === ')' || ch === '}' || ch === ']') {
        if (!started) { prevNonSpace = ch; continue; }
        depth--;
        prevNonSpace = ch;
        if (depth === 0) return i;
      }

      if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') {
        prevNonSpace = ch;
      }
    }
  }
  return lines.length - 1;
}

// ---------------------------------------------------------------------------
// Pass A: registerCommand handlers
// ---------------------------------------------------------------------------

const registerCmdRe = /registerCommand\(/g;
const handlers = [];

for (let i = 0; i < lines.length; i++) {
  if (lines[i].indexOf('registerCommand(') === -1) continue;

  // Find the opening ( after registerCommand
  const cmdStartCol = lines[i].indexOf('registerCommand(') + 'registerCommand('.length;

  // Extract command name — first string literal argument
  // Scan forward from registerCommand( to find the first quoted string
  let name = '(dynamic)';
  const afterOpen = lines[i].slice(cmdStartCol);
  const nameMatch = afterOpen.match(/^\s*['"]([^'"]+)['"]/);
  if (nameMatch) {
    name = nameMatch[1];
  }

  // Find the end of the entire registerCommand(...) call
  // We start at the line containing registerCommand and scan for depth=0
  // relative to the opening ( after registerCommand
  const endLine = findBodyEnd(i);

  const startIdx = i; // 0-indexed
  const endIdx = endLine; // 0-indexed

  // Count stats in the body
  const bodyLines = lines.slice(startIdx, endIdx + 1);
  const bodyText = bodyLines.join('\n');
  const vscCount = (bodyText.match(/\bvscode\./g) || []).length;
  const awaitCount = (bodyText.match(/\bawait\b/g) || []).length;
  const branchCount = (bodyText.match(/\bif\s*\(|\bswitch\b|\?\?|&&|\|\|/g) || []).length;

  handlers.push({
    name,
    start: startIdx + 1, // 1-indexed
    end: endIdx + 1,
    lines: endIdx - startIdx + 1,
    vsc: vscCount,
    await: awaitCount,
    br: branchCount,
  });
}

// ---------------------------------------------------------------------------
// Pass B: direct children of activate()
// ---------------------------------------------------------------------------

// Find activate's span
let activateStart = -1;
for (let i = 0; i < lines.length; i++) {
  if (/^\s*export\s+(async\s+)?function\s+activate\b/.test(lines[i])) {
    activateStart = i;
    break;
  }
}
if (activateStart === -1) throw new Error('activate function not found');

const activateEnd = findBodyEnd(activateStart, { startFromBrace: true });

// Find direct children: lines with exactly 2 spaces of indent that declare
// a const/let/function/async function.
const childDeclRe = /^  (?:const|let|function|async function)\s+([A-Za-z0-9_]+)\s*(?:=|\()/;

// First pass: collect all declarations
const rawChildren = [];
for (let i = activateStart + 1; i < activateEnd; i++) {
  const line = lines[i];
  if (!childDeclRe.test(line)) continue;
  const nameMatch = line.match(childDeclRe);
  if (!nameMatch) continue;
  rawChildren.push({ name: nameMatch[1], startIdx: i });
}

// Second pass: compute spans (each child ends at the next child's start,
// or at activateEnd for the last one). Count vscode refs and branches.
const children = [];
for (let idx = 0; idx < rawChildren.length; idx++) {
  const cur = rawChildren[idx];
  const next = rawChildren[idx + 1];
  const endIdx = next ? next.startIdx - 1 : activateEnd - 1;

  const bodyLines = lines.slice(cur.startIdx, endIdx + 1);
  const bodyText = bodyLines.join('\n');
  const vscCount = (bodyText.match(/\bvscode\./g) || []).length;
  const branchCount = (bodyText.match(/\bif\s*\(|\bswitch\b|\?\?|&&|\|\|/g) || []).length;

  children.push({
    name: cur.name,
    start: cur.startIdx + 1, // 1-indexed
    end: endIdx + 1,
    lines: endIdx - cur.startIdx + 1,
    vsc: vscCount,
    br: branchCount,
    overlap: false,
  });
}

// Detect overlaps (should not happen with the next-child-end approach, but
// flag just in case)
children.sort((a, b) => a.start - b.start);
for (let i = 1; i < children.length; i++) {
  const cur = children[i];
  const prev = children[i - 1];
  if (cur && prev && cur.start <= prev.end) {
    cur.overlap = true;
  }
}

// ---------------------------------------------------------------------------
// Generate markdown
// ---------------------------------------------------------------------------

const totalLines = lines.length;
const activateSpan = `${activateStart + 1}–${activateEnd + 1}`;
const handlerCount = handlers.length;
const childCount = children.length;
const zeroVscChildren = children.filter(c => c.vsc === 0);
const longChildren = children.filter(c => c.lines >= 25);

let md = '';

md += `# Extension Inventory\n\n`;
md += `Generated by \`scripts/extension-inventory.mjs\` on ${new Date().toISOString().slice(0, 10)}.\n\n`;
md += `## Summary\n\n`;
md += `| Metric | Value |\n|---|---|\n`;
md += `| Total file lines | ${totalLines} |\n`;
md += `| \`activate\` span | ${activateSpan} |\n`;
md += `| Handler count | ${handlerCount} |\n`;
md += `| Direct children of \`activate\` | ${childCount} |\n`;
md += `| Zero-\`vscode.\` children | ${zeroVscChildren.length} |\n`;
md += `\n`;

// Handler table
md += `## Handlers (registerCommand)\n\n`;
md += `Sorted by line count descending.\n\n`;
md += `| # | Command | Lines | vsc | await | br | Range |\n`;
md += `|---|---|---|---|---|---|---|\n`;
const sortedHandlers = [...handlers].sort((a, b) => b.lines - a.lines);
for (let i = 0; i < sortedHandlers.length; i++) {
  const h = sortedHandlers[i];
  if (!h) continue;
  md += `| ${i + 1} | \`${h.name}\` | ${h.lines} | ${h.vsc} | ${h.await} | ${h.br} | ${h.start}–${h.end} |\n`;
}
md += `\n`;

// Children table
md += `## Direct Children of \`activate\`\n\n`;
md += `Lines ≥ 25 only. Sorted by line count descending.\n\n`;
md += `| Name | Lines | vsc | br | Range | Notes |\n`;
md += `|---|---|---|---|---|---|\n`;
const sortedChildren = [...longChildren].sort((a, b) => b.lines - a.lines);
for (const c of sortedChildren) {
  const note = c.overlap ? '⚠ overlap' : '';
  md += `| \`${c.name}\` | ${c.lines} | ${c.vsc} | ${c.br} | ${c.start}–${c.end} | ${note} |\n`;
}
md += `\n`;

writeFileSync(outPath, md, 'utf-8');
console.error(`Wrote ${outPath}`);
console.error(`  Handlers: ${handlerCount}`);
console.error(`  Children: ${childCount} (${zeroVscChildren.length} zero-vscode)`);
console.error(`  Long children (≥25 lines): ${longChildren.length}`);

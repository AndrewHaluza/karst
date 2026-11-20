import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Guard for toast text (@arch:NTF-00). It counts violations per file and compares them with
 * four checked-in baselines, one per rewrite area. A file with MORE or FEWER violations than
 * its baseline fails, so a rewrite ticket shrinks only its own baseline file.
 */
const SRC = join(__dirname, '..');
const BASELINE_DIR = join(__dirname, 'notifyGuard');

type Area = 'extension' | 'panels-hosts' | 'ops-sandbox' | 'ops-rest';
export const AREAS: readonly Area[] = ['extension', 'panels-hosts', 'ops-sandbox', 'ops-rest'];

/** The receivers whose `.info/.warn/.error/.errorActions/.infoActions` call shows a toast. */
const RECEIVERS = new Set(['notify', 'toast', 'ask']);
const METHODS = new Set(['info', 'warn', 'error', 'errorActions', 'infoActions']);
const SHOW = /^show(Information|Warning|Error)Message$/u;
const ERROR_MESSAGE = /instanceof\s+Error\s*\?[^:]*\.message\s*:\s*String\(/u;

export function areaOf(rel: string): Area {
  if (rel === 'extension.ts') return 'extension';
  if (/^extension\/ops\/sandbox/u.test(rel)) return 'ops-sandbox';
  if (rel.startsWith('extension/ops/') || rel === 'extension/memoryBinding.ts') return 'ops-rest';
  return 'panels-hosts';
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'node_modules') sourceFiles(p, out);
    } else if (/\.tsx?$/u.test(name) && !/\.(test|spec)\.tsx?$/u.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function receiverName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isNonNullExpression(expr) || ts.isParenthesizedExpression(expr)) return receiverName(expr.expression);
  return undefined;
}

function isToastCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const method = callee.name.text;
  if (SHOW.test(method)) return true;
  const recv = receiverName(callee.expression);
  return METHODS.has(method) && recv !== undefined && RECEIVERS.has(recv);
}

/** The literal text parts and the `${…}` expression sources of a string or template argument. */
function textOf(arg: ts.Expression | undefined, sf: ts.SourceFile): { text: string; exprs: string[] } | undefined {
  if (!arg) return undefined;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return { text: arg.text, exprs: [] };
  if (ts.isTemplateExpression(arg)) {
    return {
      text: arg.head.text + arg.templateSpans.map((s) => `\u0000${s.literal.text}`).join(''),
      exprs: arg.templateSpans.map((s) => s.expression.getText(sf)),
    };
  }
  return undefined;
}

export function violatesText(text: string, exprs: readonly string[]): boolean {
  const plain = text.replace(/\u0000/gu, '');
  return (
    /^\s*karst:/iu.test(plain) ||
    /^\s*Ticket\s/u.test(plain) ||
    plain.includes('(s)') ||
    plain.includes('Please') ||
    exprs.some((e) => ERROR_MESSAGE.test(e))
  );
}

function countViolations(file: string): number {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  let n = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isToastCall(node)) {
      const parts = textOf(node.arguments[0], sf);
      if (parts && violatesText(parts.text, parts.exprs)) n += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return n;
}

function actual(): Record<Area, Map<string, number>> {
  const out = Object.fromEntries(AREAS.map((a) => [a, new Map<string, number>()])) as Record<Area, Map<string, number>>;
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file).split('\\').join('/');
    const n = countViolations(file);
    if (n > 0) out[areaOf(rel)].set(rel, n);
  }
  return out;
}

function baseline(area: Area): Map<string, number> {
  const path = join(BASELINE_DIR, `${area}.txt`);
  const map = new Map<string, number>();
  if (!existsSync(path)) return map;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^(\S+):(\d+)$/u.exec(line.trim());
    if (m) map.set(m[1]!, Number(m[2]));
  }
  return map;
}

function asObject(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b)));
}

/** `NOTIFY_GUARD_UPDATE=1` rewrites the baselines from the current source (a rewrite ticket's last step). */
function writeBaselines(found: Record<Area, Map<string, number>>): void {
  mkdirSync(BASELINE_DIR, { recursive: true });
  for (const area of AREAS) {
    const lines = Object.entries(asObject(found[area])).map(([f, n]) => `${f}:${n}\n`);
    writeFileSync(join(BASELINE_DIR, `${area}.txt`), lines.join(''));
  }
}

describe('toast text guard (@arch:NTF-00)', () => {
  const found = actual();
  if (process.env.NOTIFY_GUARD_UPDATE === '1') writeBaselines(found);
  for (const area of AREAS) {
    it(`${area}: violations per file equal the checked-in baseline`, () => {
      expect(asObject(found[area])).toEqual(asObject(baseline(area)));
    });
  }

  it('detects each banned pattern in a toast call', () => {
    const src = [
      "notify.info('Karst: x');",
      "deps.notify.warn('karst: x');",
      "toast.error(`Ticket ${id}: x`);",
      "window.showInformationMessage('files(s)');",
      "deps.notify.errorActions?.('Please retry', ['A']);",
      "notify.error(`failed: ${err instanceof Error ? err.message : String(err)}`);",
      "notify.info('Created sub-task KAR-1.');",
      'notify.info(text);',
      "logger.info('Karst: fine');",
    ].join('\n');
    const sf = ts.createSourceFile('x.ts', src, ts.ScriptTarget.Latest, true);
    const hits: boolean[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isToastCall(node)) {
        const parts = textOf(node.arguments[0], sf);
        hits.push(parts ? violatesText(parts.text, parts.exprs) : false);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(hits).toEqual([true, true, true, true, true, true, false, false]);
  });

  it('maps a file to its rewrite area', () => {
    expect(areaOf('extension.ts')).toBe('extension');
    expect(areaOf('extension/ops/sandboxSetupOp.ts')).toBe('ops-sandbox');
    expect(areaOf('extension/ops/lifecycleOps.ts')).toBe('ops-rest');
    expect(areaOf('extension/memoryBinding.ts')).toBe('ops-rest');
    expect(areaOf('extension/dashboardActions.ts')).toBe('panels-hosts');
    expect(areaOf('ui/dashboard/messagePump.ts')).toBe('panels-hosts');
  });
});

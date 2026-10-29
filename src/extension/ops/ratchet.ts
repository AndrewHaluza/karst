import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GitRunner } from '../../integrations/git.js';

export const ALLOWED_EXTENSION_GROWTH = 15;
export const COARSE_EXTENSION_CEILING = 9100;
export const MAX_EXTENSION_LINES = COARSE_EXTENSION_CEILING;

export function calculateGrowth(baseCount: number, currentCount: number): number {
  return currentCount - baseCount;
}

export function extensionGrowthErrorMessage(growth: number, allowed = ALLOWED_EXTENSION_GROWTH): string {
  return `src/extension.ts grew by ${growth} lines in this change (allowed: ${allowed}). Move the logic into a module under src/extension/ (a *Binding.ts, or ops/ for vscode-free logic) and keep only the wiring call here.`;
}

export function extensionCeilingErrorMessage(lineCount: number, ceiling = COARSE_EXTENSION_CEILING): string {
  return `src/extension.ts line count (${lineCount}) exceeds the coarse ceiling (${ceiling}) when base is unavailable. Move the logic into a module under src/extension/ (a *Binding.ts, or ops/ for vscode-free logic) and keep only the wiring call here.`;
}

export function countLines(text: string): number {
  return text.split('\n').length;
}

export async function resolveBaseRef(
  git: GitRunner,
  cwd: string,
  baseBranch = 'develop',
): Promise<string | null> {
  try {
    const remote = await git(['rev-parse', '--verify', `origin/${baseBranch}`], cwd);
    if (remote.exitCode === 0) {
      return `origin/${baseBranch}`;
    }
    const local = await git(['rev-parse', '--verify', baseBranch], cwd);
    if (local.exitCode === 0) {
      return baseBranch;
    }
    return null;
  } catch {
    return null;
  }
}

export async function resolveMergeBase(
  git: GitRunner,
  cwd: string,
  baseBranch = 'develop',
): Promise<string | null> {
  try {
    const baseRef = await resolveBaseRef(git, cwd, baseBranch);
    if (!baseRef) return null;
    const mb = await git(['merge-base', baseRef, 'HEAD'], cwd);
    if (mb.exitCode === 0 && mb.stdout.trim()) {
      return mb.stdout.trim();
    }
    return null;
  } catch {
    return null;
  }
}

export async function readBaseFileContent(
  git: GitRunner,
  cwd: string,
  mergeBase: string,
  relPath: string,
): Promise<string | null> {
  try {
    const res = await git(['show', `${mergeBase}:${relPath}`], cwd);
    if (res.exitCode === 0) {
      return res.stdout;
    }
    return null;
  } catch {
    return null;
  }
}

export interface CheckExtensionRatchetDeps {
  git?: GitRunner;
  cwd?: string;
  filePath?: string;
  relPath?: string;
  baseBranch?: string;
  allowedGrowth?: number;
  ceiling?: number;
  readFile?: (path: string) => Promise<string> | string;
  currentSource?: string;
}

export interface ExtensionRatchetResult {
  ok: boolean;
  growth?: number;
  currentLines: number;
  baseLines?: number;
  ceiling: number;
  mergeBase?: string;
  errorMessage?: string;
}

export async function checkExtensionRatchet(
  deps: CheckExtensionRatchetDeps = {},
): Promise<ExtensionRatchetResult> {
  const cwd = deps.cwd ?? process.cwd();
  const relPath = (deps.relPath ?? join('src', 'extension.ts')).replace(/\\/g, '/');
  const allowedGrowth = deps.allowedGrowth ?? ALLOWED_EXTENSION_GROWTH;
  const ceiling = deps.ceiling ?? COARSE_EXTENSION_CEILING;

  let currentSource = deps.currentSource;
  if (currentSource === undefined) {
    const absPath = deps.filePath ?? join(cwd, relPath);
    if (deps.readFile) {
      currentSource = await deps.readFile(absPath);
    } else {
      currentSource = readFileSync(absPath, 'utf8');
    }
  }

  const currentLines = countLines(currentSource);

  let mergeBase: string | null = null;
  let baseSource: string | null = null;

  if (deps.git) {
    try {
      mergeBase = await resolveMergeBase(deps.git, cwd, deps.baseBranch ?? 'develop');
      if (mergeBase) {
        baseSource = await readBaseFileContent(deps.git, cwd, mergeBase, relPath);
      }
    } catch {
      mergeBase = null;
      baseSource = null;
    }
  }

  if (mergeBase && baseSource !== null) {
    const baseLines = countLines(baseSource);
    const growth = calculateGrowth(baseLines, currentLines);
    if (growth > allowedGrowth) {
      const errorMessage = extensionGrowthErrorMessage(growth, allowedGrowth);
      return {
        ok: false,
        growth,
        currentLines,
        baseLines,
        ceiling,
        mergeBase,
        errorMessage,
      };
    }
    return {
      ok: true,
      growth,
      currentLines,
      baseLines,
      ceiling,
      mergeBase,
    };
  }

  if (currentLines > ceiling) {
    const errorMessage = extensionCeilingErrorMessage(currentLines, ceiling);
    return {
      ok: false,
      currentLines,
      ceiling,
      errorMessage,
    };
  }

  return {
    ok: true,
    currentLines,
    ceiling,
  };
}

export async function assertExtensionRatchet(
  deps: CheckExtensionRatchetDeps = {},
): Promise<ExtensionRatchetResult> {
  const result = await checkExtensionRatchet(deps);
  if (!result.ok) {
    throw new Error(result.errorMessage);
  }
  return result;
}

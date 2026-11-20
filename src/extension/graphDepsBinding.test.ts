import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type * as VscodeApi from 'vscode';
import { openWorkspaceDepsEditor } from './graphDepsBinding.js';

const YAML = 'repositories:\n  web:\n    repoPath: ../web\n';

function fakeVscode(log: string[], dirty = false): typeof VscodeApi {
  class Position {
    constructor(readonly line: number, readonly character: number) {}
  }
  class Range {
    constructor(readonly start: Position, readonly end: Position) {}
  }
  class Selection {
    constructor(readonly anchor: Position, readonly active: Position) {}
  }
  class WorkspaceEdit {
    insert(uri: unknown, at: Position, text: string): void {
      log.push(`insert@${at.line}:${JSON.stringify(text)}`);
    }
  }
  const editor = {
    selection: undefined as unknown,
    revealRange: (r: Range, type: unknown) => log.push(`reveal@${r.start.line}:${String(type)}`),
  };
  return {
    Position,
    Range,
    Selection,
    WorkspaceEdit,
    TextEditorRevealType: { InCenter: 2 },
    Uri: { file: (p: string) => ({ path: p }) },
    workspace: {
      openTextDocument: async (uri: { path: string }) => (log.push(`open:${uri.path}`), { uri, isDirty: dirty }),
      applyEdit: async () => (log.push('apply'), true),
    },
    window: {
      showTextDocument: async () => (log.push('show'), editor),
    },
  } as unknown as typeof VscodeApi;
}

const notify = (log: string[]) => ({
  info: (m: string) => void log.push(`info:${m}`),
  warn: (m: string) => void log.push(`warn:${m}`),
  error: async (m: string) => void log.push(`error:${m}`),
});

describe('openWorkspaceDepsEditor', () => {
  it('inserts the key as an editor edit, shows the document and reveals the line', async () => {
    const log: string[] = [];
    await openWorkspaceDepsEditor(
      { vscode: fakeVscode(log), manifestPath: () => '/p/karst.yml', notify: notify(log), readFile: () => YAML },
      'graph-workspace-deps: node run 5 (web: x)',
    );
    expect(log.slice(0, 4)).toEqual(['open:/p/karst.yml', 'insert@2:"    graphWorkspace: {}\\n"', 'apply', 'show']);
    expect(log.some((l) => l.startsWith('reveal@'))).toBe(true);
  });

  it('does not edit a buffer with unsaved changes', async () => {
    const log: string[] = [];
    await openWorkspaceDepsEditor(
      { vscode: fakeVscode(log, true), manifestPath: () => '/p/karst.yml', notify: notify(log), readFile: () => YAML },
      'graph-workspace-deps: node run 5 (web: x)',
    );
    expect(log.some((l) => l === 'apply' || l.startsWith('insert'))).toBe(false);
    expect(log).toContain('show');
  });

  it('opens without an edit when the key exists', async () => {
    const log: string[] = [];
    await openWorkspaceDepsEditor(
      {
        vscode: fakeVscode(log),
        manifestPath: () => '/p/karst.yml',
        notify: notify(log),
        readFile: () => `${YAML}    graphWorkspace:\n      link: []\n`,
      },
      'graph-workspace-deps: node run 5 (web: x)',
    );
    expect(log.filter((l) => l === 'apply' || l.startsWith('insert'))).toEqual([]);
    expect(log).toContain('show');
  });

  it('tells the user when the manifest cannot be read', async () => {
    const log: string[] = [];
    await openWorkspaceDepsEditor(
      {
        vscode: fakeVscode(log),
        manifestPath: () => {
          throw new Error('none');
        },
        notify: notify(log),
      },
      'graph-workspace-deps: node run 5 (web: x)',
    );
    expect(log.filter((l) => l.startsWith('warn:'))).toEqual(['warn:No karst.yml exists to edit. Run the setup session first.']);
    expect(log).not.toContain('show');
  });

  it('reads karst.yml from disk by default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wde-'));
    try {
      writeFileSync(join(dir, 'karst.yml'), YAML);
      const log: string[] = [];
      await openWorkspaceDepsEditor(
        { vscode: fakeVscode(log), manifestPath: () => join(dir, 'karst.yml'), notify: notify(log) },
        'graph-workspace-deps: node run 5 (web: x)',
      );
      expect(log.some((l) => l.startsWith('insert@2:'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

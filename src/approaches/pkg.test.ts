import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  approachDir,
  readApproachPackage,
  writeApproachPackage,
  writeApproachArtifacts,
  readArtifactBody,
  listArtifacts,
  listInstalled,
  readPromptBody,
  uninstallApproach,
  type ApproachPackage,
  type ApproachArtifact,
} from './pkg.js';
import { ManifestError } from '../manifest/schema.js';
import type { WorkflowPhase } from '../manifest/types.js';

const dirs: string[] = [];

function makeBaseDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'karst-approaches-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('approachDir', () => {
  it('joins baseDir and id', () => {
    const base = makeBaseDir();
    expect(approachDir(base, 'my-approach')).toBe(join(base, 'my-approach'));
  });

  it('throws ManifestError for id containing a forward slash', () => {
    const base = makeBaseDir();
    expect(() => approachDir(base, 'foo/bar')).toThrow(ManifestError);
  });

  it('throws ManifestError for id containing a backslash', () => {
    const base = makeBaseDir();
    expect(() => approachDir(base, 'foo\\bar')).toThrow(ManifestError);
  });

  it('throws ManifestError for id containing ..', () => {
    const base = makeBaseDir();
    expect(() => approachDir(base, '..')).toThrow(ManifestError);
    expect(() => approachDir(base, '../escape')).toThrow(ManifestError);
  });

  it('throws ManifestError for an absolute id', () => {
    const base = makeBaseDir();
    expect(() => approachDir(base, '/etc/passwd')).toThrow(ManifestError);
  });
});

describe('writeApproachPackage / readApproachPackage round-trip', () => {
  it('writes metadata + prompt files and reads them back', () => {
    const base = makeBaseDir();
    const pkg: ApproachPackage = {
      id: 'tdd-approach',
      label: 'TDD Approach',
      description: 'Write tests first',
      entrypoint: 'main.md',
      prompts: ['main.md', 'sub.md'],
    };
    const prompts = [
      { name: 'main.md', body: '# Main prompt' },
      { name: 'sub.md', body: '# Sub prompt' },
    ];

    writeApproachPackage(base, pkg, prompts);

    const dir = approachDir(base, 'tdd-approach');
    expect(readFileSync(join(dir, 'prompts', 'main.md'), 'utf8')).toBe('# Main prompt');
    expect(readFileSync(join(dir, 'prompts', 'sub.md'), 'utf8')).toBe('# Sub prompt');

    const result = readApproachPackage(base, 'tdd-approach');
    expect(result).not.toBeNull();
    expect(result?.id).toBe('tdd-approach');
    expect(result?.label).toBe('TDD Approach');
    expect(result?.description).toBe('Write tests first');
    expect(result?.entrypoint).toBe('main.md');
    expect(result?.prompts).toEqual(['main.md', 'sub.md']);
  });

  it('round-trips without optional fields', () => {
    const base = makeBaseDir();
    const pkg: ApproachPackage = {
      id: 'minimal',
      label: 'Minimal',
      prompts: ['only.md'],
    };
    writeApproachPackage(base, pkg, [{ name: 'only.md', body: 'body text' }]);

    const result = readApproachPackage(base, 'minimal');
    expect(result).toEqual({
      id: 'minimal',
      label: 'Minimal',
      prompts: ['only.md'],
    });
  });

  it('does not mutate the input pkg object', () => {
    const base = makeBaseDir();
    const pkg: ApproachPackage = {
      id: 'immutable-check',
      label: 'Immutable',
      prompts: ['a.md'],
    };
    const frozen = Object.freeze({ ...pkg, prompts: Object.freeze([...pkg.prompts]) });
    expect(() =>
      writeApproachPackage(base, frozen as ApproachPackage, [{ name: 'a.md', body: 'x' }]),
    ).not.toThrow();
  });
});

describe('readApproachPackage on missing package', () => {
  it('returns null when approach.yml does not exist', () => {
    const base = makeBaseDir();
    expect(readApproachPackage(base, 'does-not-exist')).toBeNull();
  });
});

describe('path-traversal guards', () => {
  it('writeApproachPackage throws for id with separator', () => {
    const base = makeBaseDir();
    const pkg: ApproachPackage = { id: '../evil', label: 'Evil', prompts: [] };
    expect(() => writeApproachPackage(base, pkg, [])).toThrow(ManifestError);
  });

  it('readApproachPackage throws for id with separator', () => {
    const base = makeBaseDir();
    expect(() => readApproachPackage(base, 'a/../../b')).toThrow(ManifestError);
  });

  it('writeApproachPackage throws when a prompt name contains a separator', () => {
    const base = makeBaseDir();
    const pkg: ApproachPackage = {
      id: 'ok-id',
      label: 'OK',
      prompts: ['../escape.md'],
    };
    expect(() =>
      writeApproachPackage(base, pkg, [{ name: '../escape.md', body: 'x' }]),
    ).toThrow(ManifestError);
  });

  it('writeApproachPackage throws when a prompt name contains a backslash', () => {
    const base = makeBaseDir();
    const pkg: ApproachPackage = {
      id: 'ok-id-2',
      label: 'OK',
      prompts: ['sub\\escape.md'],
    };
    expect(() =>
      writeApproachPackage(base, pkg, [{ name: 'sub\\escape.md', body: 'x' }]),
    ).toThrow(ManifestError);
  });
});

describe('readApproachPackage malformed yaml', () => {
  it('throws ManifestError on invalid yaml content', () => {
    const base = makeBaseDir();
    const dir = join(base, 'broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'approach.yml'), '{ this: is: not: valid: yaml: [');
    expect(() => readApproachPackage(base, 'broken')).toThrow(ManifestError);
  });

  it('throws ManifestError when required fields are missing', () => {
    const base = makeBaseDir();
    const dir = join(base, 'missing-fields');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'approach.yml'), 'label: No id here\nprompts: []\n');
    expect(() => readApproachPackage(base, 'missing-fields')).toThrow(ManifestError);
  });

  it('throws ManifestError when prompts is not an array of strings', () => {
    const base = makeBaseDir();
    const dir = join(base, 'bad-prompts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'approach.yml'),
      'id: bad-prompts\nlabel: Bad\nprompts:\n  - 1\n  - 2\n',
    );
    expect(() => readApproachPackage(base, 'bad-prompts')).toThrow(ManifestError);
  });
});

describe('listInstalled', () => {
  it('returns empty array when baseDir does not exist', () => {
    // No need to create the directory; we're testing the non-existent case.
    const base = join(tmpdir(), 'does-not-exist-' + Date.now());
    const result = listInstalled(base);
    expect(result).toEqual([]);
  });

  it('returns empty array when baseDir is empty', () => {
    const base = makeBaseDir();
    const result = listInstalled(base);
    expect(result).toEqual([]);
  });

  it('returns all valid packages', () => {
    const base = makeBaseDir();
    const pkg1: ApproachPackage = {
      id: 'pkg-a',
      label: 'Package A',
      prompts: ['main.md'],
    };
    const pkg2: ApproachPackage = {
      id: 'pkg-b',
      label: 'Package B',
      description: 'Second package',
      prompts: ['guide.md'],
    };

    writeApproachPackage(base, pkg1, [{ name: 'main.md', body: 'pkg a' }]);
    writeApproachPackage(base, pkg2, [{ name: 'guide.md', body: 'pkg b' }]);

    const result = listInstalled(base);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe('pkg-a');
    expect(result[1]!.id).toBe('pkg-b');
  });

  it('skips malformed packages (missing approach.yml)', () => {
    const base = makeBaseDir();
    const pkg1: ApproachPackage = {
      id: 'pkg-valid',
      label: 'Valid Package',
      prompts: ['main.md'],
    };

    // Write a valid package
    writeApproachPackage(base, pkg1, [{ name: 'main.md', body: 'content' }]);

    // Create a malformed package (no approach.yml)
    const malformedDir = join(base, 'pkg-empty');
    mkdirSync(malformedDir, { recursive: true });

    const result = listInstalled(base);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('pkg-valid');
  });

  it('skips malformed packages (invalid yaml)', () => {
    const base = makeBaseDir();
    const pkg1: ApproachPackage = {
      id: 'pkg-good',
      label: 'Good Package',
      prompts: ['main.md'],
    };

    // Write a valid package
    writeApproachPackage(base, pkg1, [{ name: 'main.md', body: 'content' }]);

    // Create a malformed package (broken yaml)
    const malformedDir = join(base, 'pkg-broken');
    mkdirSync(malformedDir, { recursive: true });
    writeFileSync(join(malformedDir, 'approach.yml'), '{ invalid: yaml: [');

    const result = listInstalled(base);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('pkg-good');
  });

  it('skips malformed packages (missing required fields)', () => {
    const base = makeBaseDir();
    const pkg1: ApproachPackage = {
      id: 'pkg-valid-two',
      label: 'Valid Two',
      prompts: ['x.md'],
    };

    // Write a valid package
    writeApproachPackage(base, pkg1, [{ name: 'x.md', body: 'y' }]);

    // Create a malformed package (missing id field)
    const malformedDir = join(base, 'pkg-no-id');
    mkdirSync(malformedDir, { recursive: true });
    writeFileSync(join(malformedDir, 'approach.yml'), 'label: No id\nprompts: []\n');

    const result = listInstalled(base);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('pkg-valid-two');
  });
});

describe('readPromptBody', () => {
  it('returns the body of an existing prompt file', () => {
    const dir = makeBaseDir();
    writeApproachPackage(
      dir,
      { id: 'tdd', label: 'TDD', prompts: ['research.md'] },
      [{ name: 'research.md', body: '# Research first\n' }],
    );
    expect(readPromptBody(dir, 'tdd', 'research.md')).toBe('# Research first\n');
  });

  it('returns null when the prompt file is absent', () => {
    const dir = makeBaseDir();
    writeApproachPackage(dir, { id: 'tdd', label: 'TDD', prompts: [] }, []);
    expect(readPromptBody(dir, 'tdd', 'missing.md')).toBeNull();
  });

  it('returns null when the package dir does not exist', () => {
    const dir = makeBaseDir();
    expect(readPromptBody(dir, 'nope', 'x.md')).toBeNull();
  });

  it('throws on an id with a path separator', () => {
    expect(() => readPromptBody('/base', '../evil', 'x.md')).toThrow();
  });

  it('throws on a prompt name with ".."', () => {
    expect(() => readPromptBody('/base', 'tdd', '../../etc/passwd')).toThrow();
  });
});

describe('writeApproachArtifacts / structure-preserving package', () => {
  it('writes files at their relPath under <id>/ and records typed artifacts', () => {
    const base = makeBaseDir();
    const artifacts: ApproachArtifact[] = [
      { kind: 'agent', relPath: 'agents/research.md' },
      { kind: 'skill', relPath: 'skills/writing-plans/SKILL.md' },
      { kind: 'command', relPath: 'commands/plan.md' },
    ];
    const pkg: ApproachPackage = {
      id: 'structured',
      label: 'Structured',
      entrypoint: 'research',
      prompts: [],
      artifacts,
    };
    const files = [
      { relPath: 'agents/research.md', body: '# research agent' },
      { relPath: 'skills/writing-plans/SKILL.md', body: '# writing plans skill' },
      { relPath: 'commands/plan.md', body: '# plan command' },
    ];

    writeApproachArtifacts(base, pkg, files);

    const dir = approachDir(base, 'structured');
    expect(readFileSync(join(dir, 'agents', 'research.md'), 'utf8')).toBe('# research agent');
    expect(readFileSync(join(dir, 'skills', 'writing-plans', 'SKILL.md'), 'utf8')).toBe(
      '# writing plans skill',
    );
    expect(readFileSync(join(dir, 'commands', 'plan.md'), 'utf8')).toBe('# plan command');

    const result = readApproachPackage(base, 'structured');
    expect(result?.entrypoint).toBe('research');
    expect(result?.artifacts).toEqual(artifacts);
  });

  it('reads an artifact body back by relPath', () => {
    const base = makeBaseDir();
    const pkg: ApproachPackage = {
      id: 'read-art',
      label: 'Read Art',
      prompts: [],
      artifacts: [{ kind: 'skill', relPath: 'skills/tdd/SKILL.md' }],
    };
    writeApproachArtifacts(base, pkg, [
      { relPath: 'skills/tdd/SKILL.md', body: 'tdd body' },
    ]);
    expect(readArtifactBody(base, 'read-art', 'skills/tdd/SKILL.md')).toBe('tdd body');
  });

  it('readArtifactBody returns null when the artifact is absent', () => {
    const base = makeBaseDir();
    writeApproachArtifacts(base, { id: 'empty', label: 'E', prompts: [], artifacts: [] }, []);
    expect(readArtifactBody(base, 'empty', 'agents/missing.md')).toBeNull();
  });

  it('listArtifacts filters by kind', () => {
    const base = makeBaseDir();
    const artifacts: ApproachArtifact[] = [
      { kind: 'agent', relPath: 'agents/a.md' },
      { kind: 'agent', relPath: 'agents/b.md' },
      { kind: 'skill', relPath: 'skills/s/SKILL.md' },
    ];
    const pkg: ApproachPackage = { id: 'k', label: 'K', prompts: [], artifacts };
    expect(listArtifacts(pkg, 'agent')).toEqual([
      { kind: 'agent', relPath: 'agents/a.md' },
      { kind: 'agent', relPath: 'agents/b.md' },
    ]);
    expect(listArtifacts(pkg, 'skill')).toEqual([{ kind: 'skill', relPath: 'skills/s/SKILL.md' }]);
    expect(listArtifacts(pkg, 'command')).toEqual([]);
  });

  it('rejects a relPath that escapes the package dir (traversal)', () => {
    const base = makeBaseDir();
    const pkg: ApproachPackage = {
      id: 'evil',
      label: 'Evil',
      prompts: [],
      artifacts: [{ kind: 'agent', relPath: '../escape.md' }],
    };
    expect(() =>
      writeApproachArtifacts(base, pkg, [{ relPath: '../escape.md', body: 'x' }]),
    ).toThrow(ManifestError);
  });

  it('rejects an absolute relPath', () => {
    const base = makeBaseDir();
    expect(() => readArtifactBody(base, 'k', '/etc/passwd')).toThrow(ManifestError);
  });

  it('round-trips a package with no artifacts (back-compat: field omitted)', () => {
    const base = makeBaseDir();
    writeApproachPackage(base, { id: 'legacy', label: 'Legacy', prompts: ['only.md'] }, [
      { name: 'only.md', body: 'x' },
    ]);
    const result = readApproachPackage(base, 'legacy');
    expect(result?.artifacts).toBeUndefined();
    expect(result?.prompts).toEqual(['only.md']);
  });
});

describe('workflow persistence', () => {
  it('round-trips workflow through writeApproachArtifacts / readApproachPackage', () => {
    const base = makeBaseDir();
    const workflow: WorkflowPhase[] = [{ name: 'research', command: '/rpi:research' }];
    const pkg: ApproachPackage = {
      id: 'with-workflow',
      label: 'With Workflow',
      prompts: [],
      workflow,
    };
    writeApproachArtifacts(base, pkg, []);

    const result = readApproachPackage(base, 'with-workflow');
    expect(result?.workflow).toEqual(workflow);
  });

  it('a package written without workflow reads workflow === undefined', () => {
    const base = makeBaseDir();
    const pkg: ApproachPackage = {
      id: 'no-workflow',
      label: 'No Workflow',
      prompts: [],
    };
    writeApproachArtifacts(base, pkg, []);

    const result = readApproachPackage(base, 'no-workflow');
    expect(result?.workflow).toBeUndefined();
  });

  it('round-trips workflow through writeApproachPackage as well', () => {
    const base = makeBaseDir();
    const workflow: WorkflowPhase[] = [
      { name: 'describe' },
      { name: 'plan', command: '/rpi:plan', description: 'Plan the change' },
    ];
    const pkg: ApproachPackage = {
      id: 'legacy-with-workflow',
      label: 'Legacy With Workflow',
      prompts: ['main.md'],
      workflow,
    };
    writeApproachPackage(base, pkg, [{ name: 'main.md', body: 'x' }]);

    const result = readApproachPackage(base, 'legacy-with-workflow');
    expect(result?.workflow).toEqual(workflow);
  });

  it('does not mutate the input pkg.workflow array', () => {
    const base = makeBaseDir();
    const workflow: WorkflowPhase[] = [{ name: 'research', command: '/rpi:research' }];
    const frozenPhase = Object.freeze({ ...workflow[0]! });
    const frozenWorkflow = Object.freeze([frozenPhase]);
    const pkg: ApproachPackage = {
      id: 'immutable-workflow',
      label: 'Immutable Workflow',
      prompts: [],
      workflow: frozenWorkflow as unknown as WorkflowPhase[],
    };
    expect(() => writeApproachArtifacts(base, pkg, [])).not.toThrow();
  });

  it('throws ManifestError on read when a workflow phase is missing name', () => {
    const base = makeBaseDir();
    const dir = join(base, 'bad-workflow');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'approach.yml'),
      'id: bad-workflow\nlabel: Bad\nprompts: []\nworkflow:\n  - command: /rpi:research\n',
    );
    expect(() => readApproachPackage(base, 'bad-workflow')).toThrow(ManifestError);
  });

  it('throws ManifestError on read when workflow is not an array', () => {
    const base = makeBaseDir();
    const dir = join(base, 'bad-workflow-shape');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'approach.yml'),
      'id: bad-workflow-shape\nlabel: Bad\nprompts: []\nworkflow: "not an array"\n',
    );
    expect(() => readApproachPackage(base, 'bad-workflow-shape')).toThrow(ManifestError);
  });
});

/**
 * A phase name is interpolated into a shell command line the agent executes
 * (the `karst stage impl phase <name>` marker), and approach.yml comes from an
 * untrusted fetched source. A name is therefore a shell token, not free text.
 */
describe('workflow phase name charset', () => {
  /** Write an approach.yml whose single phase carries `name` verbatim. */
  function writePhaseName(base: string, id: string, name: string): void {
    const dir = join(base, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'approach.yml'),
      `id: ${id}\nlabel: Bad\nprompts: []\nworkflow:\n  - name: ${JSON.stringify(name)}\n`,
    );
  }

  it.each([
    ['research'],
    ['implement'],
    ['describe'],
    ['plan'],
    ['step-1'],
    ['step_two'],
    ['Phase3'],
  ])('accepts the safe name %j', (name) => {
    const base = makeBaseDir();
    writePhaseName(base, 'ok-phase', name);
    expect(readApproachPackage(base, 'ok-phase')?.workflow).toEqual([{ name }]);
  });

  it.each([
    ['semicolon', 'research; rm -rf ~'],
    ['pipe', 'research | cat'],
    ['ampersand', 'research & sleep 9'],
    ['dollar', 'research $HOME'],
    ['backtick', 'research `whoami`'],
    ['double quote', 'research"'],
    ['single quote', "research'"],
    ['newline', 'research\nrm -rf ~'],
    ['redirect in', 'research < /etc/passwd'],
    ['redirect out', 'research > /tmp/x'],
    ['open paren', 'research(x'],
    ['close paren', 'research)'],
    ['space', 'do research'],
    ['leading dash', '-rf'],
  ])('rejects a name containing a %s', (_label, name) => {
    const base = makeBaseDir();
    writePhaseName(base, 'hostile-phase', name);
    expect(() => readApproachPackage(base, 'hostile-phase')).toThrow(ManifestError);
    expect(() => readApproachPackage(base, 'hostile-phase')).toThrow(/workflow\[0\]\.name/);
  });

  it('names the offending phase by index and says why', () => {
    const base = makeBaseDir();
    const dir = join(base, 'hostile-second');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'approach.yml'),
      'id: hostile-second\nlabel: Bad\nprompts: []\nworkflow:\n' +
        '  - name: research\n  - name: "plan; rm -rf ~"\n',
    );
    expect(() => readApproachPackage(base, 'hostile-second')).toThrow(
      /workflow\[1\]\.name.*plan; rm -rf ~/s,
    );
    // The message must explain the reason, not merely assert invalidity.
    expect(() => readApproachPackage(base, 'hostile-second')).toThrow(/shell/i);
  });

  it('still rejects an empty name', () => {
    const base = makeBaseDir();
    writePhaseName(base, 'empty-phase', '');
    expect(() => readApproachPackage(base, 'empty-phase')).toThrow(ManifestError);
  });

  it('still rejects a whitespace-only name', () => {
    const base = makeBaseDir();
    writePhaseName(base, 'blank-phase', '   ');
    expect(() => readApproachPackage(base, 'blank-phase')).toThrow(ManifestError);
  });

  it('rejects a name longer than the 64-character bound', () => {
    const base = makeBaseDir();
    writePhaseName(base, 'long-phase', 'a'.repeat(65));
    expect(() => readApproachPackage(base, 'long-phase')).toThrow(ManifestError);
  });
});

describe('uninstallApproach', () => {
  it('removes an installed package directory and returns true', () => {
    const base = makeBaseDir();
    const pkg: ApproachPackage = {
      id: 'to-remove',
      label: 'Remove Me',
      prompts: ['main.md'],
    };
    writeApproachPackage(base, pkg, [{ name: 'main.md', body: 'content' }]);

    // Verify package is there
    expect(readApproachPackage(base, 'to-remove')).not.toBeNull();

    // Remove it
    const result = uninstallApproach(base, 'to-remove');
    expect(result).toBe(true);

    // Verify it is gone
    expect(readApproachPackage(base, 'to-remove')).toBeNull();
  });

  it('returns false when the package directory does not exist', () => {
    const base = makeBaseDir();
    const result = uninstallApproach(base, 'does-not-exist');
    expect(result).toBe(false);
  });

  it('is reflected in listInstalled after removal', () => {
    const base = makeBaseDir();
    const pkg1: ApproachPackage = {
      id: 'keep-this',
      label: 'Keep',
      prompts: ['a.md'],
    };
    const pkg2: ApproachPackage = {
      id: 'remove-this',
      label: 'Remove',
      prompts: ['b.md'],
    };

    writeApproachPackage(base, pkg1, [{ name: 'a.md', body: 'a' }]);
    writeApproachPackage(base, pkg2, [{ name: 'b.md', body: 'b' }]);

    expect(listInstalled(base)).toHaveLength(2);

    uninstallApproach(base, 'remove-this');

    const remaining = listInstalled(base);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe('keep-this');
  });

  it('throws ManifestError for an id with path separator', () => {
    const base = makeBaseDir();
    expect(() => uninstallApproach(base, '../evil')).toThrow(ManifestError);
  });

  it('throws ManifestError for an id with ".."', () => {
    const base = makeBaseDir();
    expect(() => uninstallApproach(base, '..')).toThrow(ManifestError);
  });

  it('throws ManifestError for an absolute id', () => {
    const base = makeBaseDir();
    expect(() => uninstallApproach(base, '/etc/passwd')).toThrow(ManifestError);
  });
});

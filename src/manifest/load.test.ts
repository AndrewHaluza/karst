import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManifest } from './load.js';

/** Write YAML to a temp file, return its path; caller cleans the dir. */
function fixture(yaml: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'karst-manifest-'));
  const path = join(dir, 'karst.yml');
  writeFileSync(path, yaml);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const VALID = `
host: localhost
portRange: [4000, 4999]
baselineBranch: develop
services:
  backend:
    repoPath: ../backend
    start: npm run dev
    health: "http://{host}:{port}/health"
    ports:
      - { name: http, env: PORT, default: 3000 }
      - { name: debug, env: DEBUG_PORT, default: 9229 }
    dependsOn: []
  frontend:
    repoPath: ../frontend
    start: npm run dev
    ports:
      - { name: http, env: PORT, default: 5173 }
    dependsOn:
      - target: backend
        port: http
        bind:
          - { env: VITE_API_URL, template: "http://{host}:{port}" }
`;

describe('loadManifest', () => {
  it('parses a valid manifest into the typed model', () => {
    const { path, cleanup } = fixture(VALID);
    try {
      const m = loadManifest(path);
      expect(m.host).toBe('localhost');
      expect(m.portRange).toEqual([4000, 4999]);
      expect(m.baselineBranch).toBe('develop');
      expect(Object.keys(m.services)).toEqual(['backend', 'frontend']);

      const be = m.services.backend!;
      expect(be.repoPath).toBe('../backend');
      expect(be.start).toBe('npm run dev');
      expect(be.health).toBe('http://{host}:{port}/health');
      expect(be.ports).toHaveLength(2);
      expect(be.ports[0]).toEqual({ name: 'http', env: 'PORT', default: 3000 });
      expect(be.dependsOn).toEqual([]);

      const fe = m.services.frontend!;
      expect(fe.dependsOn[0]).toEqual({
        target: 'backend',
        port: 'http',
        bind: [{ env: 'VITE_API_URL', template: 'http://{host}:{port}' }],
      });
    } finally {
      cleanup();
    }
  });

  it('defaults hasMigrations to false when omitted', () => {
    const { path, cleanup } = fixture(VALID);
    try {
      const m = loadManifest(path);
      expect(m.services.backend!.hasMigrations).toBe(false);
      expect(m.services.frontend!.hasMigrations).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('reads hasMigrations when declared', () => {
    const yaml = VALID.replace(
      'dependsOn: []\n  frontend:',
      'dependsOn: []\n    hasMigrations: true\n  frontend:',
    );
    const { path, cleanup } = fixture(yaml);
    try {
      expect(loadManifest(path).services.backend!.hasMigrations).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('throws a clear error on an unknown dependsOn.target', () => {
    const yaml = VALID.replace('target: backend', 'target: nonexistent');
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/nonexistent/);
    } finally {
      cleanup();
    }
  });

  it('throws when a port slot is missing its env field', () => {
    const yaml = VALID.replace('{ name: http, env: PORT, default: 3000 }', '{ name: http, default: 3000 }');
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/env/i);
    } finally {
      cleanup();
    }
  });

  it('throws when a dependsOn.port names a slot the target does not have', () => {
    const yaml = VALID.replace('port: http', 'port: ws');
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/ws/);
    } finally {
      cleanup();
    }
  });

  it('throws on malformed YAML', () => {
    const { path, cleanup } = fixture('host: [unclosed');
    try {
      expect(() => loadManifest(path)).toThrow();
    } finally {
      cleanup();
    }
  });

  it('throws when services is empty or missing', () => {
    const { path, cleanup } = fixture('host: localhost\nportRange: [4000,4999]\nbaselineBranch: develop\n');
    try {
      expect(() => loadManifest(path)).toThrow(/services/i);
    } finally {
      cleanup();
    }
  });

  it('throws when portRange is not a [min,max] number pair', () => {
    const yaml = VALID.replace('portRange: [4000, 4999]', 'portRange: 4000');
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/portRange/);
    } finally {
      cleanup();
    }
  });

  it('throws when portRange min exceeds max', () => {
    const yaml = VALID.replace('portRange: [4000, 4999]', 'portRange: [4999, 4000]');
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/exceeds max/);
    } finally {
      cleanup();
    }
  });

  it('throws when top level is not a mapping', () => {
    const { path, cleanup } = fixture('- just\n- a\n- list\n');
    try {
      expect(() => loadManifest(path)).toThrow(/top level/);
    } finally {
      cleanup();
    }
  });

  it('throws when a dependsOn edge has an empty bind', () => {
    const yaml = VALID.replace(
      'bind:\n          - { env: VITE_API_URL, template: "http://{host}:{port}" }',
      'bind: []',
    );
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/bind/);
    } finally {
      cleanup();
    }
  });

  it('throws when a service is missing repoPath', () => {
    const yaml = VALID.replace('    repoPath: ../backend\n', '');
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/repoPath/);
    } finally {
      cleanup();
    }
  });

  it('throws when a service has no ports', () => {
    const yaml = VALID.replace(
      '    ports:\n      - { name: http, env: PORT, default: 5173 }\n',
      '    ports: []\n',
    );
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/ports/);
    } finally {
      cleanup();
    }
  });

  it('throws ManifestError when the file does not exist', () => {
    expect(() => loadManifest('/no/such/karst.yml')).toThrow(/cannot read/);
  });
});

describe('service signals', () => {
  it('defaults signals to [] when omitted (unclassified)', () => {
    const { path, cleanup } = fixture(VALID);
    try {
      const m = loadManifest(path);
      expect(m.services.backend!.signals).toEqual([]);
      expect(m.services.frontend!.signals).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('parses declared signal words', () => {
    const yaml = VALID.replace(
      '    dependsOn: []\n  frontend:',
      '    dependsOn: []\n    signals: [api, endpoint, migration]\n  frontend:',
    );
    const { path, cleanup } = fixture(yaml);
    try {
      expect(loadManifest(path).services.backend!.signals).toEqual([
        'api',
        'endpoint',
        'migration',
      ]);
    } finally {
      cleanup();
    }
  });

  it('throws when a signal is not a non-empty string', () => {
    const yaml = VALID.replace(
      '    dependsOn: []\n  frontend:',
      '    dependsOn: []\n    signals: [api, ""]\n  frontend:',
    );
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/signals/i);
    } finally {
      cleanup();
    }
  });

  it('throws when signals is not an array', () => {
    const yaml = VALID.replace(
      '    dependsOn: []\n  frontend:',
      '    dependsOn: []\n    signals: nope\n  frontend:',
    );
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/signals/i);
    } finally {
      cleanup();
    }
  });
});

describe('approaches', () => {
  const withApproaches = (block: string): string =>
    `${VALID}\napproaches:\n${block}`;

  it('defaults approaches to [] when omitted', () => {
    const { path, cleanup } = fixture(VALID);
    try {
      expect(loadManifest(path).approaches).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('parses approaches with a recommended flag', () => {
    const yaml = withApproaches(
      '  - { id: rpi, label: "Research → Plan → Implement", recommended: true }\n' +
        '  - { id: tdd, label: "TDD" }\n',
    );
    const { path, cleanup } = fixture(yaml);
    try {
      const m = loadManifest(path);
      expect(m.approaches!).toHaveLength(2);
      expect(m.approaches![0]).toEqual({
        id: 'rpi',
        label: 'Research → Plan → Implement',
        recommended: true,
        enabled: true,
      });
      expect(m.approaches![1]!.recommended).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('throws on duplicate approach ids', () => {
    const yaml = withApproaches(
      '  - { id: rpi, label: A }\n  - { id: rpi, label: B }\n',
    );
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/duplicate.*rpi|rpi.*duplicate/i);
    } finally {
      cleanup();
    }
  });

  it('throws when an approach is missing id or label', () => {
    const yaml = withApproaches('  - { label: "no id" }\n');
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/id/i);
    } finally {
      cleanup();
    }
  });

  it('throws when more than one approach is recommended', () => {
    const yaml = withApproaches(
      '  - { id: a, label: A, recommended: true }\n' +
        '  - { id: b, label: B, recommended: true }\n',
    );
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/recommended/i);
    } finally {
      cleanup();
    }
  });

  it('parses description and entrypoint when present', () => {
    const yaml = withApproaches(
      '  - { id: rpi, label: RPI, description: "when to use it", entrypoint: research }\n',
    );
    const { path, cleanup } = fixture(yaml);
    try {
      const m = loadManifest(path);
      expect(m.approaches![0]).toEqual({
        id: 'rpi',
        label: 'RPI',
        description: 'when to use it',
        entrypoint: 'research',
        enabled: true,
      });
    } finally {
      cleanup();
    }
  });

  it('leaves description and entrypoint absent when omitted', () => {
    const yaml = withApproaches('  - { id: rpi, label: RPI }\n');
    const { path, cleanup } = fixture(yaml);
    try {
      const m = loadManifest(path);
      expect(m.approaches![0]).not.toHaveProperty('description');
      expect(m.approaches![0]).not.toHaveProperty('entrypoint');
    } finally {
      cleanup();
    }
  });

  it('parses a valid git source', () => {
    const yaml = withApproaches(
      '  - id: rpi\n' +
        '    label: RPI\n' +
        '    source:\n' +
        '      type: git\n' +
        '      repo: "https://github.com/example/approach.git"\n' +
        '      ref: main\n' +
        '      include: ["prompts/", "approach.yml"]\n',
    );
    const { path, cleanup } = fixture(yaml);
    try {
      const m = loadManifest(path);
      expect(m.approaches![0]!.source).toEqual({
        type: 'git',
        repo: 'https://github.com/example/approach.git',
        ref: 'main',
        include: ['prompts/', 'approach.yml'],
      });
    } finally {
      cleanup();
    }
  });

  it('parses a valid npm source', () => {
    const yaml = withApproaches(
      '  - id: rpi\n' +
        '    label: RPI\n' +
        '    source:\n' +
        '      type: npm\n' +
        '      package: "@example/approach"\n' +
        '      command: "npm install @example/approach"\n' +
        '      collect: ["dist/prompts/"]\n',
    );
    const { path, cleanup } = fixture(yaml);
    try {
      const m = loadManifest(path);
      expect(m.approaches![0]!.source).toEqual({
        type: 'npm',
        package: '@example/approach',
        command: 'npm install @example/approach',
        collect: ['dist/prompts/'],
      });
    } finally {
      cleanup();
    }
  });

  it('throws on an unknown source type', () => {
    const yaml = withApproaches(
      '  - id: rpi\n' +
        '    label: RPI\n' +
        '    source:\n' +
        '      type: svn\n' +
        '      repo: whatever\n',
    );
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/type/i);
    } finally {
      cleanup();
    }
  });

  it('throws when a git source is missing include', () => {
    const yaml = withApproaches(
      '  - id: rpi\n' +
        '    label: RPI\n' +
        '    source:\n' +
        '      type: git\n' +
        '      repo: "https://github.com/example/approach.git"\n' +
        '      ref: main\n',
    );
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/include/i);
    } finally {
      cleanup();
    }
  });

  it('parses a workflow phase list', () => {
    const yaml = withApproaches(
      '  - id: rpi\n' +
        '    label: RPI\n' +
        '    workflow:\n' +
        '      - { name: research, command: "/rpi:research" }\n' +
        '      - { name: implement, description: "code it up" }\n',
    );
    const { path, cleanup } = fixture(yaml);
    try {
      const m = loadManifest(path);
      expect(m.approaches![0]!.workflow).toEqual([
        { name: 'research', command: '/rpi:research' },
        { name: 'implement', description: 'code it up' },
      ]);
    } finally {
      cleanup();
    }
  });

  it('leaves workflow absent when omitted', () => {
    const yaml = withApproaches('  - { id: rpi, label: RPI }\n');
    const { path, cleanup } = fixture(yaml);
    try {
      expect(loadManifest(path).approaches![0]).not.toHaveProperty('workflow');
    } finally {
      cleanup();
    }
  });

  it('throws when a workflow phase is missing name', () => {
    const yaml = withApproaches(
      '  - id: rpi\n' +
        '    label: RPI\n' +
        '    workflow:\n' +
        '      - { command: "/rpi:research" }\n',
    );
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/name/i);
    } finally {
      cleanup();
    }
  });

  it('defaults enabled to true when omitted', () => {
    const yaml = withApproaches('  - { id: rpi, label: RPI }\n');
    const { path, cleanup } = fixture(yaml);
    try {
      expect(loadManifest(path).approaches![0]!.enabled).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('preserves enabled: false', () => {
    const yaml = withApproaches('  - { id: rpi, label: RPI, enabled: false }\n');
    const { path, cleanup } = fixture(yaml);
    try {
      expect(loadManifest(path).approaches![0]!.enabled).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe('agents', () => {
  it('defaults agents to {} when omitted', () => {
    const { path, cleanup } = fixture(VALID);
    try {
      expect(loadManifest(path).agents).toEqual({});
    } finally {
      cleanup();
    }
  });

  it('parses role-keyed agents', () => {
    const yaml = `${VALID}\nagents:\n  research: { role: research, command: "claude research" }\n  plan: { role: plan }\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      const m = loadManifest(path);
      expect(m.agents!.research).toEqual({
        role: 'research',
        command: 'claude research',
        enabled: true,
      });
      expect(m.agents!.plan).toEqual({ role: 'plan', enabled: true });
    } finally {
      cleanup();
    }
  });

  it('throws when an agent is missing its role', () => {
    const yaml = `${VALID}\nagents:\n  research: { command: "x" }\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/role/i);
    } finally {
      cleanup();
    }
  });

  it('loads a legacy agent entry with enabled defaulting to true', () => {
    const yaml = `${VALID}\nagents:\n  r: { role: research }\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(loadManifest(path).agents!.r).toEqual({ role: 'research', enabled: true });
    } finally {
      cleanup();
    }
  });

  it('preserves enabled: false and promptPath', () => {
    const yaml = `${VALID}\nagents:\n  research: { role: research, enabled: false, promptPath: "agents/research.md" }\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(loadManifest(path).agents!.research).toEqual({
        role: 'research',
        enabled: false,
        promptPath: 'agents/research.md',
      });
    } finally {
      cleanup();
    }
  });
});

describe('ticketing', () => {
  it("defaults to { provider: 'manual' } when omitted", () => {
    const { path, cleanup } = fixture(VALID);
    try {
      expect(loadManifest(path).ticketing).toEqual({ provider: 'manual' });
    } finally {
      cleanup();
    }
  });

  it('parses a clickup provider with teamId and listId', () => {
    const yaml = `${VALID}\nticketing:\n  provider: clickup\n  teamId: "9001"\n  listId: "42"\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(loadManifest(path).ticketing).toEqual({
        provider: 'clickup',
        teamId: '9001',
        listId: '42',
      });
    } finally {
      cleanup();
    }
  });

  it('leaves teamId and listId absent when omitted', () => {
    const yaml = `${VALID}\nticketing:\n  provider: clickup\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      const t = loadManifest(path).ticketing!;
      expect(t.provider).toBe('clickup');
      expect(t).not.toHaveProperty('teamId');
      expect(t).not.toHaveProperty('listId');
    } finally {
      cleanup();
    }
  });

  it('throws on an unknown provider', () => {
    const yaml = `${VALID}\nticketing:\n  provider: jira\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/provider/i);
    } finally {
      cleanup();
    }
  });

  it('throws when teamId is present but not a non-empty string', () => {
    const yaml = `${VALID}\nticketing:\n  provider: clickup\n  teamId: ""\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/teamId/i);
    } finally {
      cleanup();
    }
  });

  it('throws when ticketing is not a mapping', () => {
    const yaml = `${VALID}\nticketing: nope\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/ticketing/i);
    } finally {
      cleanup();
    }
  });
});

describe('agentProvider', () => {
  it("defaults to 'claude' when omitted", () => {
    const { path, cleanup } = fixture(VALID);
    try {
      expect(loadManifest(path).agentProvider).toBe('claude');
    } finally {
      cleanup();
    }
  });

  it("preserves an explicit 'codex' setting", () => {
    const { path, cleanup } = fixture(`${VALID}\nagentProvider: codex\n`);
    try {
      expect(loadManifest(path).agentProvider).toBe('codex');
    } finally {
      cleanup();
    }
  });

  it('throws on an invalid value', () => {
    const { path, cleanup } = fixture(`${VALID}\nagentProvider: gpt\n`);
    try {
      expect(() => loadManifest(path)).toThrow(/agentProvider/i);
    } finally {
      cleanup();
    }
  });
});

describe('worktreePathDisplay', () => {
  it('defaults to relative when omitted', () => {
    const { path, cleanup } = fixture(VALID);
    try {
      expect(loadManifest(path).worktreePathDisplay).toBe('relative');
    } finally {
      cleanup();
    }
  });

  it('parses an explicit absolute setting', () => {
    const { path, cleanup } = fixture(`${VALID}\nworktreePathDisplay: absolute\n`);
    try {
      expect(loadManifest(path).worktreePathDisplay).toBe('absolute');
    } finally {
      cleanup();
    }
  });

  it('throws on an invalid value', () => {
    const { path, cleanup } = fixture(`${VALID}\nworktreePathDisplay: sideways\n`);
    try {
      expect(() => loadManifest(path)).toThrow(/worktreePathDisplay/i);
    } finally {
      cleanup();
    }
  });
});

describe('ticketLabelTemplate', () => {
  it('is undefined when omitted', () => {
    const { path, cleanup } = fixture(VALID);
    try {
      expect(loadManifest(path).ticketLabelTemplate).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('parses an explicit template string', () => {
    const { path, cleanup } = fixture(`${VALID}\nticketLabelTemplate: "{key} · {stage}"\n`);
    try {
      expect(loadManifest(path).ticketLabelTemplate).toBe('{key} · {stage}');
    } finally {
      cleanup();
    }
  });

  it('normalizes a blank template to undefined (falls back to default)', () => {
    const { path, cleanup } = fixture(`${VALID}\nticketLabelTemplate: "   "\n`);
    try {
      expect(loadManifest(path).ticketLabelTemplate).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('throws when the template is not a string', () => {
    const { path, cleanup } = fixture(`${VALID}\nticketLabelTemplate: 42\n`);
    try {
      expect(() => loadManifest(path)).toThrow(/ticketLabelTemplate/i);
    } finally {
      cleanup();
    }
  });
});

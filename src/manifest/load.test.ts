import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManifest, loadManifestWithDiagnostics } from './load.js';

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
repositories:
  backend:
    repoPath: ../backend
    service:
      start: npm run dev
      health: "http://{host}:{port}/health"
      ports:
        - { name: http, env: PORT, default: 3000 }
        - { name: debug, env: DEBUG_PORT, default: 9229 }
      dependsOn: []
  frontend:
    repoPath: ../frontend
    service:
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
      expect(Object.keys(m.repositories)).toEqual(['backend', 'frontend']);

      const be = m.repositories.backend!;
      expect(be.repoPath).toBe('../backend');
      expect(be.service!.start).toBe('npm run dev');
      expect(be.service!.health).toBe('http://{host}:{port}/health');
      expect(be.service!.ports).toHaveLength(2);
      expect(be.service!.ports[0]).toEqual({ name: 'http', env: 'PORT', default: 3000 });
      expect(be.service!.dependsOn).toEqual([]);

      const fe = m.repositories.frontend!;
      expect(fe.service!.dependsOn[0]).toEqual({
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
      expect(m.repositories.backend!.hasMigrations).toBe(false);
      expect(m.repositories.frontend!.hasMigrations).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('reads hasMigrations when declared', () => {
    const yaml = VALID.replace(
      '      dependsOn: []\n  frontend:',
      '      dependsOn: []\n    hasMigrations: true\n  frontend:',
    );
    const { path, cleanup } = fixture(yaml);
    try {
      expect(loadManifest(path).repositories.backend!.hasMigrations).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('reads a repository baselineBranch override while leaving others inherited', () => {
    const yaml = VALID.replace(
      '    repoPath: ../backend',
      '    repoPath: ../backend\n    baselineBranch: release',
    );
    const { path, cleanup } = fixture(yaml);
    try {
      const m = loadManifest(path);
      expect(m.repositories.backend!.baselineBranch).toBe('release');
      expect(m.repositories.frontend!.baselineBranch).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('rejects conflicting baseline branches for entries sharing one repoPath', () => {
    const yaml = VALID
      .replace(
        '    repoPath: ../backend',
        '    repoPath: ../shared\n    baselineBranch: release',
      )
      .replace('    repoPath: ../frontend', '    repoPath: ../shared');
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(
        /repositories "backend" and "frontend".*repoPath.*different baseline branches/,
      );
    } finally {
      cleanup();
    }
  });

  it('accepts repository names that differ in case', () => {
    const yaml = VALID.replace('  backend:', '  BE:').replace('target: backend', 'target: BE');
    const { path, cleanup } = fixture(yaml);
    try {
      expect(Object.keys(loadManifest(path).repositories)).toEqual(['BE', 'frontend']);
    } finally {
      cleanup();
    }
  });

  it('rejects two repository names that differ only by case', () => {
    const yaml = VALID.replace('  frontend:', '  BACKEND:');
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(
        /repositories "backend" and "BACKEND" differ only by case/,
      );
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

  it('throws when repositories is empty or missing', () => {
    const { path, cleanup } = fixture('host: localhost\nportRange: [4000,4999]\nbaselineBranch: develop\n');
    try {
      expect(() => loadManifest(path)).toThrow(/repositories/i);
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

  describe('per-service portRange', () => {
    it('reads an optional per-service portRange from the manifest', () => {
      const yaml = VALID.replace(
        '      dependsOn: []\n',
        '      portRange: [5000, 5100]\n      dependsOn: []\n',
      );
      const { path, cleanup } = fixture(yaml);
      try {
        expect(loadManifest(path).repositories.backend!.service!.portRange).toEqual([5000, 5100]);
      } finally {
        cleanup();
      }
    });

    it('defaults service.portRange to undefined when absent', () => {
      const { path, cleanup } = fixture(VALID);
      try {
        expect(loadManifest(path).repositories.backend!.service!.portRange).toBeUndefined();
      } finally {
        cleanup();
      }
    });

    it('throws when service.portRange is not a [min, max] number pair', () => {
      const yaml = VALID.replace(
        '      dependsOn: []\n',
        '      portRange: 5000\n      dependsOn: []\n',
      );
      const { path, cleanup } = fixture(yaml);
      try {
        expect(() => loadManifest(path)).toThrow(/service\.portRange must be a \[min, max\] number pair/);
      } finally {
        cleanup();
      }
    });

    it('throws when service.portRange min exceeds max', () => {
      const yaml = VALID.replace(
        '      dependsOn: []\n',
        '      portRange: [5100, 5000]\n      dependsOn: []\n',
      );
      const { path, cleanup } = fixture(yaml);
      try {
        expect(() => loadManifest(path)).toThrow(/exceeds max/);
      } finally {
        cleanup();
      }
    });

    it('throws when a service.portRange endpoint is not a valid port', () => {
      const yaml = VALID.replace(
        '      dependsOn: []\n',
        '      portRange: [0, 5000]\n      dependsOn: []\n',
      );
      const { path, cleanup } = fixture(yaml);
      try {
        expect(() => loadManifest(path)).toThrow(/1 and 65535/);
      } finally {
        cleanup();
      }
    });

    it('accepts an incomplete portRange on a disabled draft repository', () => {
      const yaml = VALID
        .replace(
          '    repoPath: ../backend\n    service:',
          '    repoPath: ../backend\n    enabled: false\n    service:',
        )
        .replace(
          '    repoPath: ../frontend\n    service:',
          '    repoPath: ../frontend\n    enabled: false\n    service:',
        )
        .replace(
          '      dependsOn: []\n',
          '      portRange: [0, 0]\n      dependsOn: []\n',
        );
      const { path, cleanup } = fixture(yaml);
      try {
        expect(loadManifest(path).repositories.backend!.service!.portRange).toEqual([0, 0]);
      } finally {
        cleanup();
      }
    });

    it('rejects a portRange at repository level as a stray runtime field', () => {
      const yaml = VALID.replace(
        '    repoPath: ../backend\n    service:',
        '    repoPath: ../backend\n    portRange: [5000, 5100]\n    service:',
      );
      const { path, cleanup } = fixture(yaml);
      try {
        expect(() => loadManifest(path)).toThrow(/at repository level/);
        expect(() => loadManifest(path)).toThrow(/move it under/);
      } finally {
        cleanup();
      }
    });
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
      'bind:\n            - { env: VITE_API_URL, template: "http://{host}:{port}" }',
      'bind: []',
    );
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/bind/);
    } finally {
      cleanup();
    }
  });

  it('throws when a repository is missing repoPath', () => {
    const yaml = VALID.replace('    repoPath: ../backend\n', '');
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/repoPath/);
    } finally {
      cleanup();
    }
  });

  it('throws when a DECLARED service has no ports', () => {
    const yaml = VALID.replace(
      '      ports:\n        - { name: http, env: PORT, default: 5173 }\n',
      '      ports: []\n',
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

  // Every validation message must say WHICH karst.yml is wrong: a user may have
  // one per project plus the example, and a bare "portRange must be ..." is not
  // actionable against a set of files.
  it('names the offending file in the error message', () => {
    const { path, cleanup } = fixture(VALID.replace('portRange: [4000, 4999]', 'portRange: 4000'));
    try {
      expect(() => loadManifest(path)).toThrow(path);
    } finally {
      cleanup();
    }
  });

  // Task 8: `uat.testerVerifier` is a host-authored GateDef (never AI output)
  // and must survive load with its shape intact.
  it('loads an optional uat.testerVerifier gate', () => {
    const yaml = `${VALID}
uat:
  testerVerifier:
    name: verify-uat
    kind: command
    command: ./scripts/verify-uat.sh
`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(loadManifest(path).uat?.testerVerifier).toEqual({
        name: 'verify-uat',
        kind: 'command',
        command: './scripts/verify-uat.sh',
      });
    } finally {
      cleanup();
    }
  });

  it('leaves uat.testerVerifier absent for a manifest without a uat block', () => {
    const { path, cleanup } = fixture(VALID);
    try {
      expect(loadManifest(path).uat).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  // Task 3.1: uat.testerObservations.blockingSeverity — the ONE manifest knob
  // that lets a project opt a Tester observation's severity into blocking
  // UAT's verdict. Defaults to 'none' so every existing manifest, and every
  // manifest that omits the block entirely, behaves byte-identically.
  it('reads uat.testerObservations.blockingSeverity', () => {
    const yaml = `${VALID}
uat:
  maxFixAttempts: 2
  testerObservations:
    blockingSeverity: high
`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(loadManifest(path).uat?.testerObservations?.blockingSeverity).toBe('high');
    } finally {
      cleanup();
    }
  });

  it('defaults uat.testerObservations.blockingSeverity to none', () => {
    const yaml = `${VALID}
uat:
  maxFixAttempts: 2
`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(loadManifest(path).uat?.testerObservations?.blockingSeverity ?? 'none').toBe('none');
    } finally {
      cleanup();
    }
  });

  it('rejects an unknown uat.testerObservations.blockingSeverity', () => {
    const yaml = `${VALID}
uat:
  maxFixAttempts: 2
  testerObservations:
    blockingSeverity: URGENT
`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/blockingSeverity/);
    } finally {
      cleanup();
    }
  });
});

describe('repositories without a service', () => {
  const DOCS = `
host: localhost
portRange: [4000, 4999]
baselineBranch: develop
repositories:
  docs:
    repoPath: ../docs
    signals: [readme, guide]
`;

  // The motivating case: karst's own extension repo is edited, never run. Before
  // this, registering it required inventing a fake start command and a fake port.
  it('accepts a repository that declares no service', () => {
    const { path, cleanup } = fixture(DOCS);
    try {
      const docs = loadManifest(path).repositories.docs!;
      expect(docs.repoPath).toBe('../docs');
      expect(docs.service).toBeUndefined();
      expect(docs.signals).toEqual(['readme', 'guide']);
    } finally {
      cleanup();
    }
  });

  it('accepts a manifest whose repositories are ALL non-runnable', () => {
    const { path, cleanup } = fixture(DOCS);
    try {
      expect(Object.keys(loadManifest(path).repositories)).toEqual(['docs']);
    } finally {
      cleanup();
    }
  });

  // A half-migrated file leaves runtime fields at repository level, where they
  // are inert — accepting them would silently turn a runnable repo into a
  // non-runnable one and nothing would ever start.
  it.each(['start: npm run dev', 'ports: []', 'dependsOn: []', 'health: "http://x"', 'portRange: [5000, 5100]'])(
    'rejects the stray repository-level runtime field %s',
    (field) => {
      const { path, cleanup } = fixture(`${DOCS}    ${field}\n`);
      try {
        expect(() => loadManifest(path)).toThrow(/at repository level/);
        expect(() => loadManifest(path)).toThrow(/move it under/);
      } finally {
        cleanup();
      }
    },
  );

  // `health` is optional, and the settings UI seeds an empty input for it. Blank
  // must therefore mean "not set", the way every other optional string in this
  // manifest normalizes — not "invalid", which would report a required-field
  // error for a field that is not required.
  it('normalizes a blank health to unset rather than rejecting it', () => {
    const yaml = `${DOCS}    service:\n      start: npm run dev\n      health: ""\n      ports:\n        - { name: http, env: PORT, default: 3000 }\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(loadManifest(path).repositories.docs!.service!.health).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('still rejects a non-string health', () => {
    const yaml = `${DOCS}    service:\n      start: npm run dev\n      health: 42\n      ports:\n        - { name: http, env: PORT, default: 3000 }\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/service\.health/);
    } finally {
      cleanup();
    }
  });

  it('rejects a declared service with no start command', () => {
    const yaml = `${DOCS}    service:\n      ports:\n        - { name: http, env: PORT, default: 3000 }\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/service\.start/);
    } finally {
      cleanup();
    }
  });

  it('tells the author to omit `service:` when a declared one has no ports', () => {
    const yaml = `${DOCS}    service:\n      start: npm run dev\n      ports: []\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/omit the whole/);
    } finally {
      cleanup();
    }
  });

  // You cannot bind to a port that does not exist.
  it('rejects a dependsOn edge targeting a repository with no service', () => {
    const yaml = `${VALID}  docs:\n    repoPath: ../docs\n`.replace(
      'target: backend',
      'target: docs',
    );
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/declares no service/);
    } finally {
      cleanup();
    }
  });
});

describe('repository enabled / draft', () => {
  const DRAFT = `
host: localhost
portRange: [4000, 4999]
baselineBranch: develop
repositories:
  scratch:
    repoPath: ""
    enabled: false
`;

  it('accepts a disabled repository with a blank repoPath (draft)', () => {
    const { path, cleanup } = fixture(DRAFT);
    try {
      const repo = loadManifest(path).repositories.scratch!;
      expect(repo.repoPath).toBe('');
      expect(repo.enabled).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('defaults enabled to true when absent (back-compat)', () => {
    const { path, cleanup } = fixture(VALID);
    try {
      expect(loadManifest(path).repositories.backend!.enabled).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('still requires repoPath when enabled is true (or absent)', () => {
    const yaml = DRAFT.replace('enabled: false', 'enabled: true');
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/repoPath must be a non-empty string/);
    } finally {
      cleanup();
    }
  });

  it('accepts a disabled repository whose service is half-filled', () => {
    const yaml = `${DRAFT}    service:\n      start: ""\n      health: ""\n      ports: []\n      dependsOn: []\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      const repo = loadManifest(path).repositories.scratch!;
      expect(repo.service!.start).toBe('');
      expect(repo.service!.ports).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('rejects a half-filled service once enabled is true', () => {
    const yaml = `${DRAFT.replace('enabled: false', 'enabled: true').replace('repoPath: ""', 'repoPath: "."')}    service:\n      start: ""\n      ports: []\n      dependsOn: []\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/service\.start must be a non-empty string/);
    } finally {
      cleanup();
    }
  });

  it('still rejects a non-string repoPath even when disabled', () => {
    const yaml = DRAFT.replace('repoPath: ""', 'repoPath: 42');
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/repoPath must be a string/);
    } finally {
      cleanup();
    }
  });
});

describe('legacy `services:` manifests', () => {
  const LEGACY = `
host: localhost
portRange: [4000, 4999]
baselineBranch: develop
services:
  backend:
    repoPath: ../backend
    start: npm run dev
    ports:
      - { name: http, env: PORT, default: 3000 }
    dependsOn: []
    hasMigrations: true
    signals: [api]
`;

  it('still loads, translating each entry into a repository with a service', () => {
    const { path, cleanup } = fixture(LEGACY);
    try {
      const be = loadManifest(path).repositories.backend!;
      expect(be.repoPath).toBe('../backend');
      expect(be.hasMigrations).toBe(true);
      expect(be.signals).toEqual(['api']);
      expect(be.service!.start).toBe('npm run dev');
      expect(be.service!.ports[0]!.default).toBe(3000);
    } finally {
      cleanup();
    }
  });

  it('reports a deprecation warning naming the fix', () => {
    const { path, cleanup } = fixture(LEGACY);
    try {
      const { warnings } = loadManifestWithDiagnostics(path);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/legacy `services:` key/);
    } finally {
      cleanup();
    }
  });

  it('reports no warning for a current manifest', () => {
    const { path, cleanup } = fixture(VALID);
    try {
      expect(loadManifestWithDiagnostics(path).warnings).toEqual([]);
    } finally {
      cleanup();
    }
  });

  // Never guess which key is authoritative.
  it('refuses a file carrying BOTH keys, naming the file', () => {
    const { path, cleanup } = fixture(`${LEGACY}repositories:\n  docs:\n    repoPath: ../docs\n`);
    try {
      expect(() => loadManifest(path)).toThrow(/both `repositories:` and the legacy/);
      expect(() => loadManifest(path)).toThrow(path);
    } finally {
      cleanup();
    }
  });

  // An ordinary monorepo with two runnable processes: two legacy `services:`
  // entries at the same repoPath. This used to load fine; PR #32 briefly made
  // it a hard load-time failure (`assertDistinctRepoPaths`). Two repository
  // entries sharing a repoPath is the INTENDED shape now — the worktree slug
  // is per-ticket, not per-entry — so this must load end to end, migration
  // included.
  it('migrates two legacy entries sharing one repoPath into two repositories that still share it', () => {
    const yaml = `
host: localhost
portRange: [4000, 4999]
baselineBranch: develop
services:
  api:
    repoPath: ../mono
    start: npm run api
    ports:
      - { name: http, env: PORT, default: 3000 }
    dependsOn: []
  web:
    repoPath: ../mono
    start: npm run web
    ports:
      - { name: http, env: PORT, default: 3001 }
    dependsOn: []
`;
    const { path, cleanup } = fixture(yaml);
    try {
      const { manifest, warnings } = loadManifestWithDiagnostics(path);
      expect(warnings).toHaveLength(1);
      expect(Object.keys(manifest.repositories)).toEqual(['api', 'web']);
      expect(manifest.repositories.api!.repoPath).toBe('../mono');
      expect(manifest.repositories.web!.repoPath).toBe('../mono');
      expect(manifest.repositories.api!.service!.start).toBe('npm run api');
      expect(manifest.repositories.web!.service!.start).toBe('npm run web');
    } finally {
      cleanup();
    }
  });
});

describe('repository signals', () => {
  it('defaults signals to [] when omitted (unclassified)', () => {
    const { path, cleanup } = fixture(VALID);
    try {
      const m = loadManifest(path);
      expect(m.repositories.backend!.signals).toEqual([]);
      expect(m.repositories.frontend!.signals).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('parses declared signal words', () => {
    const yaml = VALID.replace(
      '      dependsOn: []\n  frontend:',
      '      dependsOn: []\n    signals: [api, endpoint, migration]\n  frontend:',
    );
    const { path, cleanup } = fixture(yaml);
    try {
      expect(loadManifest(path).repositories.backend!.signals).toEqual([
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
      '      dependsOn: []\n  frontend:',
      '      dependsOn: []\n    signals: [api, ""]\n  frontend:',
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
      '      dependsOn: []\n  frontend:',
      '      dependsOn: []\n    signals: nope\n  frontend:',
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

  it('parses a nested graph: block with defaults applied', () => {
    const yaml = withApproaches(
      '  - id: karst-graph-engineering\n' +
        '    label: Graph Engineering\n' +
        '    enabled: false\n' +
        '    graph:\n' +
        '      planner: { profile: expert, prompt: { artifact: skills/graph-planner/SKILL.md } }\n' +
        '      profiles:\n' +
        '        expert: { provider: claude, model: claude-opus-5, effort: high }\n' +
        '        worker: { provider: claude, model: claude-sonnet-5, effort: low }\n' +
        '      commands:\n' +
        '        test: { command: npm, args: [test], cwd: repository, access: write, timeoutSeconds: 1800 }\n' +
        '      limits:\n' +
        '        maxParallel: 1\n' +
        '        maxNodeRuns: 40\n' +
        '        maxExpertRuns: 5\n' +
        '        maxReplans: 2\n',
    );
    const { path, cleanup } = fixture(yaml);
    try {
      const m = loadManifest(path);
      const g = m.approaches![0]!.graph!;
      expect(g.planner).toEqual({
        profile: 'expert',
        prompt: { artifact: 'skills/graph-planner/SKILL.md' },
      });
      expect(g.profiles.expert).toEqual({
        provider: 'claude',
        model: 'claude-opus-5',
        effort: 'high',
      });
      expect(g.commands.test).toEqual({
        command: 'npm',
        args: ['test'],
        cwd: 'repository',
        access: 'write',
        timeoutSeconds: 1800,
      });
      // Absent limit fields default to the packaged values; the fixture
      // itself configures maxParallel 1 explicitly, so it round-trips as 1
      // (the packaged default is 4 since the Slice-5 T7 concurrency flip).
      expect(g.limits).toMatchObject({
        confirmGeneratedGraph: true,
        maxParallel: 1,
        maxNodeRuns: 40,
        maxExpertRuns: 5,
        maxReplans: 2,
        maxActivations: 200,
        maxGraphWallSeconds: 86400,
        maxAggregateWorkspaceBytes: 21474836480,
      });
    } finally {
      cleanup();
    }
  });

  it('a graph: block on a non-built-in approach id validates and is inert', () => {
    const yaml = withApproaches(
      '  - id: my-custom-graph\n' +
        '    label: Custom Graph\n' +
        '    graph:\n' +
        '      limits: { maxParallel: 2 }\n',
    );
    const { path, cleanup } = fixture(yaml);
    try {
      const m = loadManifest(path);
      expect(m.approaches![0]!.graph!.limits.maxParallel).toBe(2);
    } finally {
      cleanup();
    }
  });

  it('refuses a file carrying both the flat shape and the nested graph: block', () => {
    const yaml = withApproaches(
      '  - id: karst-graph-engineering\n' +
        '    label: Graph Engineering\n' +
        '    planner: { profile: expert }\n' +
        '    graph:\n' +
        '      limits: { maxParallel: 1 }\n',
    );
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/both the nested "graph:" block and the hoisted "planner"/);
    } finally {
      cleanup();
    }
  });

  it('rejects an out-of-range graph limit at load, naming the field', () => {
    const yaml = withApproaches(
      '  - id: karst-graph-engineering\n' +
        '    label: Graph Engineering\n' +
        '    graph:\n' +
        '      limits: { maxParallel: 9 }\n',
    );
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/graph\.limits\.maxParallel must be an integer between 1 and 8/);
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
      expect(loadManifest(path).ticketing).toEqual({
        provider: 'manual',
        advanceOnShip: false,
        advanceOnStart: false,
        searchEnabled: true,
      });
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
        advanceOnShip: false,
        advanceOnStart: false,
        searchEnabled: true,
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
      expect(t.advanceOnShip).toBe(false);
      expect(t).not.toHaveProperty('teamId');
      expect(t).not.toHaveProperty('listId');
    } finally {
      cleanup();
    }
  });

  it('defaults advanceOnShip to false', () => {
    const yaml = `${VALID}\nticketing:\n  provider: clickup\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(loadManifest(path).ticketing?.advanceOnShip).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('defaults searchEnabled to true', () => {
    const yaml = `${VALID}\nticketing:\n  provider: clickup\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(loadManifest(path).ticketing?.searchEnabled).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('parses an explicit searchEnabled: false', () => {
    const yaml = `${VALID}\nticketing:\n  provider: clickup\n  searchEnabled: false\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(loadManifest(path).ticketing?.searchEnabled).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('rejects a non-boolean searchEnabled', () => {
    const yaml = `${VALID}\nticketing:\n  provider: clickup\n  searchEnabled: "yes"\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/searchEnabled must be a boolean/);
    } finally {
      cleanup();
    }
  });

  it('parses advanceOnShip and shipStatus', () => {
    const yaml =
      `${VALID}\nticketing:\n  provider: clickup\n  listId: "42"\n` +
      `  advanceOnShip: true\n  shipStatus: "in review"\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(loadManifest(path).ticketing).toEqual({
        provider: 'clickup',
        listId: '42',
        advanceOnShip: true,
        shipStatus: 'in review',
        advanceOnStart: false,
        searchEnabled: true,
      });
    } finally {
      cleanup();
    }
  });

  it('rejects advanceOnShip without a shipStatus', () => {
    const yaml = `${VALID}\nticketing:\n  provider: clickup\n  advanceOnShip: true\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/shipStatus is required/);
    } finally {
      cleanup();
    }
  });

  it('normalizes an empty shipStatus to undefined', () => {
    const yaml = `${VALID}\nticketing:\n  provider: clickup\n  shipStatus: ""\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      const t = loadManifest(path).ticketing!;
      expect(t.provider).toBe('clickup');
      expect(t).not.toHaveProperty('shipStatus');
    } finally {
      cleanup();
    }
  });

  it('rejects a blank shipStatus with advanceOnShip', () => {
    const yaml =
      `${VALID}\nticketing:\n  provider: clickup\n  advanceOnShip: true\n  shipStatus: "   "\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/shipStatus is required/);
    } finally {
      cleanup();
    }
  });

  it("rejects advanceOnShip on the 'manual' provider", () => {
    const yaml =
      `${VALID}\nticketing:\n  provider: manual\n  advanceOnShip: true\n  shipStatus: "done"\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/requires a provider that can set status/);
    } finally {
      cleanup();
    }
  });

  it('rejects a non-boolean advanceOnShip', () => {
    const yaml = `${VALID}\nticketing:\n  provider: clickup\n  advanceOnShip: "yes"\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/advanceOnShip must be a boolean/);
    } finally {
      cleanup();
    }
  });

  it('parses advanceOnStart and startStatus', () => {
    const yaml =
      `${VALID}\nticketing:\n  provider: clickup\n  listId: "42"\n` +
      `  advanceOnStart: true\n  startStatus: "in dev"\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(loadManifest(path).ticketing).toEqual({
        provider: 'clickup',
        listId: '42',
        advanceOnShip: false,
        advanceOnStart: true,
        startStatus: 'in dev',
        searchEnabled: true,
      });
    } finally {
      cleanup();
    }
  });

  it('does NOT require startStatus when advanceOnStart is true (falls back to a default)', () => {
    const yaml = `${VALID}\nticketing:\n  provider: clickup\n  advanceOnStart: true\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      const t = loadManifest(path).ticketing!;
      expect(t.advanceOnStart).toBe(true);
      expect(t).not.toHaveProperty('startStatus');
    } finally {
      cleanup();
    }
  });

  it('normalizes an empty startStatus to undefined', () => {
    const yaml = `${VALID}\nticketing:\n  provider: clickup\n  startStatus: ""\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      const t = loadManifest(path).ticketing!;
      expect(t.provider).toBe('clickup');
      expect(t).not.toHaveProperty('startStatus');
    } finally {
      cleanup();
    }
  });

  it("rejects advanceOnStart on the 'manual' provider", () => {
    const yaml = `${VALID}\nticketing:\n  provider: manual\n  advanceOnStart: true\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/requires a provider that can set status/);
    } finally {
      cleanup();
    }
  });

  it('rejects a non-boolean advanceOnStart', () => {
    const yaml = `${VALID}\nticketing:\n  provider: clickup\n  advanceOnStart: "yes"\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/advanceOnStart must be a boolean/);
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

describe('review', () => {
  it('is undefined when the block is absent', () => {
    const { path, cleanup } = fixture(VALID);
    try {
      expect(loadManifest(path).review).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('applies every default, including the findings lane ON at high severity', () => {
    const yaml = `${VALID}\nreview: {}\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(loadManifest(path).review).toEqual({
        maxFixAttempts: 3,
        requireIndependentSignal: true,
        openChanges: false,
        findings: { enabled: true, blockingSeverity: 'high', maxFindings: 50 },
        repositories: {},
      });
    } finally {
      cleanup();
    }
  });

  it('parses declared gates and a per-repository override', () => {
    const yaml =
      `${VALID}\nreview:\n  maxFixAttempts: 5\n  requireIndependentSignal: false\n` +
      `  gates:\n    - { name: lint, kind: script, script: lint }\n` +
      `  repositories:\n    backend: { gates: [{ name: lint, kind: script, script: lint:ci }] }\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      const review = loadManifest(path).review!;
      expect(review.maxFixAttempts).toBe(5);
      expect(review.requireIndependentSignal).toBe(false);
      expect(review.gates).toEqual([{ name: 'lint', kind: 'script', script: 'lint' }]);
      expect(review.repositories).toEqual({
        backend: { gates: [{ name: 'lint', kind: 'script', script: 'lint:ci' }] },
      });
    } finally {
      cleanup();
    }
  });

  // Validation is the point of this block: an unknown gate kind is refused
  // with the offending field named, not silently defaulted or dropped.
  it('refuses an unknown gate kind, naming the review field', () => {
    const yaml = `${VALID}\nreview:\n  gates:\n    - { name: x, kind: shell }\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(
        /review.gates "x".kind must be one of: script, command/,
      );
    } finally {
      cleanup();
    }
  });

  // Cross-referenced against the manifest's own declared repositories —
  // `backend`/`frontend` are declared in `VALID`, `staging` is not.
  it('refuses a review.repositories entry naming an undeclared repository', () => {
    const yaml = `${VALID}\nreview:\n  repositories:\n    staging: { gates: [] }\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(
        /review.repositories "staging" is not a declared repository/,
      );
    } finally {
      cleanup();
    }
  });

  it('refuses a non-positive maxFixAttempts', () => {
    const yaml = `${VALID}\nreview:\n  maxFixAttempts: 0\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/review.maxFixAttempts/);
    } finally {
      cleanup();
    }
  });

  it('refuses a negative maxFixAttempts', () => {
    const yaml = `${VALID}\nreview:\n  maxFixAttempts: -1\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/review.maxFixAttempts/);
    } finally {
      cleanup();
    }
  });

  it('refuses a non-integer maxFixAttempts', () => {
    const yaml = `${VALID}\nreview:\n  maxFixAttempts: 1.5\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/review.maxFixAttempts/);
    } finally {
      cleanup();
    }
  });

  it('refuses a non-numeric maxFixAttempts', () => {
    const yaml = `${VALID}\nreview:\n  maxFixAttempts: "three"\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/review.maxFixAttempts/);
    } finally {
      cleanup();
    }
  });

  it('refuses a non-boolean requireIndependentSignal', () => {
    const yaml = `${VALID}\nreview:\n  requireIndependentSignal: "yes"\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/review.requireIndependentSignal/);
    } finally {
      cleanup();
    }
  });

  it('parses an explicit review.openChanges', () => {
    const yaml = `${VALID}\nreview:\n  openChanges: true\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(loadManifest(path).review!.openChanges).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('refuses a non-boolean review.openChanges', () => {
    const yaml = `${VALID}\nreview:\n  openChanges: "yes"\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/review.openChanges/);
    } finally {
      cleanup();
    }
  });

  it('refuses an unknown findings.blockingSeverity', () => {
    const yaml = `${VALID}\nreview:\n  findings:\n    blockingSeverity: urgent\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/review.findings.blockingSeverity/);
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

  it("preserves an explicit 'antigravity' setting", () => {
    const { path, cleanup } = fixture(`${VALID}\nagentProvider: antigravity\n`);
    try {
      expect(loadManifest(path).agentProvider).toBe('antigravity');
    } finally {
      cleanup();
    }
  });

  it("preserves an explicit 'opencode' setting", () => {
    const { path, cleanup } = fixture(`${VALID}\nagentProvider: opencode\n`);
    try {
      expect(loadManifest(path).agentProvider).toBe('opencode');
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

describe('defaultEffort', () => {
  it('defaults to undefined when omitted', () => {
    const { path, cleanup } = fixture(VALID);
    try {
      expect(loadManifest(path).defaultEffort).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('preserves an explicit value', () => {
    const { path, cleanup } = fixture(`${VALID}\ndefaultEffort: high\n`);
    try {
      expect(loadManifest(path).defaultEffort).toBe('high');
    } finally {
      cleanup();
    }
  });

  it('normalizes a blank value to undefined', () => {
    const { path, cleanup } = fixture(`${VALID}\ndefaultEffort: '  '\n`);
    try {
      expect(loadManifest(path).defaultEffort).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('throws on a non-string value', () => {
    const { path, cleanup } = fixture(`${VALID}\ndefaultEffort: 42\n`);
    try {
      expect(() => loadManifest(path)).toThrow(/defaultEffort/i);
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

describe('archiveDoneAfterDays', () => {
  it('defaults to 3 days when omitted', () => {
    const { path, cleanup } = fixture(VALID);
    try {
      expect(loadManifest(path).archiveDoneAfterDays).toBe(3);
    } finally {
      cleanup();
    }
  });

  it('parses an explicit delay', () => {
    const { path, cleanup } = fixture(`${VALID}\narchiveDoneAfterDays: 7\n`);
    try {
      expect(loadManifest(path).archiveDoneAfterDays).toBe(7);
    } finally {
      cleanup();
    }
  });

  it('throws on a non-number', () => {
    const { path, cleanup } = fixture(`${VALID}\narchiveDoneAfterDays: soon\n`);
    try {
      expect(() => loadManifest(path)).toThrow(/archiveDoneAfterDays/);
    } finally {
      cleanup();
    }
  });

  it('throws on a fraction — the delay is counted in whole days', () => {
    const { path, cleanup } = fixture(`${VALID}\narchiveDoneAfterDays: 2.5\n`);
    try {
      expect(() => loadManifest(path)).toThrow(/archiveDoneAfterDays/);
    } finally {
      cleanup();
    }
  });

  it('throws on 0 — the delay exists to prevent immediate archiving', () => {
    const { path, cleanup } = fixture(`${VALID}\narchiveDoneAfterDays: 0\n`);
    try {
      expect(() => loadManifest(path)).toThrow(/archiveDoneAfterDays/);
    } finally {
      cleanup();
    }
  });

  it('throws on a negative delay', () => {
    const { path, cleanup } = fixture(`${VALID}\narchiveDoneAfterDays: -1\n`);
    try {
      expect(() => loadManifest(path)).toThrow(/archiveDoneAfterDays/);
    } finally {
      cleanup();
    }
  });
});

describe('debug', () => {
  it('is undefined when omitted (debug logging off)', () => {
    const { path, cleanup } = fixture(VALID);
    try {
      expect(loadManifest(path).debug).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('parses debug: true', () => {
    const { path, cleanup } = fixture(`${VALID}\ndebug: true\n`);
    try {
      expect(loadManifest(path).debug).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('parses debug: false', () => {
    const { path, cleanup } = fixture(`${VALID}\ndebug: false\n`);
    try {
      expect(loadManifest(path).debug).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('throws on a non-boolean — a string "true" is a YAML typo', () => {
    const { path, cleanup } = fixture(`${VALID}\ndebug: "true"\n`);
    try {
      expect(() => loadManifest(path)).toThrow(/debug must be a boolean/);
    } finally {
      cleanup();
    }
  });

  it('throws on a non-boolean number', () => {
    const { path, cleanup } = fixture(`${VALID}\ndebug: 1\n`);
    try {
      expect(() => loadManifest(path)).toThrow(/debug must be a boolean/);
    } finally {
      cleanup();
    }
  });
});

describe('closeDoneTerminalsWithTicket', () => {
  it('is undefined when omitted (done terminals stay on ticket close)', () => {
    const { path, cleanup } = fixture(VALID);
    try {
      expect(loadManifest(path).closeDoneTerminalsWithTicket).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('parses closeDoneTerminalsWithTicket: true', () => {
    const { path, cleanup } = fixture(`${VALID}\ncloseDoneTerminalsWithTicket: true\n`);
    try {
      expect(loadManifest(path).closeDoneTerminalsWithTicket).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('parses closeDoneTerminalsWithTicket: false', () => {
    const { path, cleanup } = fixture(`${VALID}\ncloseDoneTerminalsWithTicket: false\n`);
    try {
      expect(loadManifest(path).closeDoneTerminalsWithTicket).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('throws on a non-boolean — a string "true" is a YAML typo', () => {
    const { path, cleanup } = fixture(`${VALID}\ncloseDoneTerminalsWithTicket: "true"\n`);
    try {
      expect(() => loadManifest(path)).toThrow(
        /closeDoneTerminalsWithTicket must be a boolean/,
      );
    } finally {
      cleanup();
    }
  });

  it('throws on a non-boolean number', () => {
    const { path, cleanup } = fixture(`${VALID}\ncloseDoneTerminalsWithTicket: 1\n`);
    try {
      expect(() => loadManifest(path)).toThrow(
        /closeDoneTerminalsWithTicket must be a boolean/,
      );
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

describe('id (project identity)', () => {
  it('is undefined when omitted, so a legacy manifest still loads', () => {
    const { path, cleanup } = fixture(VALID);
    try {
      expect(loadManifest(path).id).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('parses an explicit project id', () => {
    const { path, cleanup } = fixture(`${VALID}\nid: karst-extension\n`);
    try {
      expect(loadManifest(path).id).toBe('karst-extension');
    } finally {
      cleanup();
    }
  });

  it('normalizes a blank id to undefined (falls back to a derived slug)', () => {
    const { path, cleanup } = fixture(`${VALID}\nid: "   "\n`);
    try {
      expect(loadManifest(path).id).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('trims surrounding whitespace so the slug matches across windows', () => {
    const { path, cleanup } = fixture(`${VALID}\nid: "  karst-extension  "\n`);
    try {
      expect(loadManifest(path).id).toBe('karst-extension');
    } finally {
      cleanup();
    }
  });

  it('throws when the id is not a string', () => {
    const { path, cleanup } = fixture(`${VALID}\nid: 42\n`);
    try {
      expect(() => loadManifest(path)).toThrow(/id/i);
    } finally {
      cleanup();
    }
  });
});

describe('terminalNameTemplate', () => {
  it('is undefined when omitted', () => {
    const { path, cleanup } = fixture(VALID);
    try {
      expect(loadManifest(path).terminalNameTemplate).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('parses an explicit template string', () => {
    const { path, cleanup } = fixture(`${VALID}\nterminalNameTemplate: "Karst: {key}"\n`);
    try {
      expect(loadManifest(path).terminalNameTemplate).toBe('Karst: {key}');
    } finally {
      cleanup();
    }
  });

  it('normalizes a blank template to undefined (falls back to default)', () => {
    const { path, cleanup } = fixture(`${VALID}\nterminalNameTemplate: "   "\n`);
    try {
      expect(loadManifest(path).terminalNameTemplate).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('throws when the template is not a string', () => {
    const { path, cleanup } = fixture(`${VALID}\nterminalNameTemplate: 5\n`);
    try {
      expect(() => loadManifest(path)).toThrow(/terminalNameTemplate/i);
    } finally {
      cleanup();
    }
  });
});

describe('artifact conventions', () => {
  it('is undefined when omitted', () => {
    const { path, cleanup } = fixture(VALID);
    try {
      expect(loadManifest(path).conventions).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('loads a fully configured section including a multiline description', () => {
    const { path, cleanup } = fixture(`${VALID}
conventions:
  commitMessage: "feat({repo}): {title} [{key}]"
  pullRequestTitle: "[{key}] {title}"
  pullRequestDescription: |
    ## Summary
    {description}

    Repository: {repo}
`);
    try {
      expect(loadManifest(path).conventions).toEqual({
        commitMessage: 'feat({repo}): {title} [{key}]',
        pullRequestTitle: '[{key}] {title}',
        pullRequestDescription: '## Summary\n{description}\n\nRepository: {repo}\n',
      });
    } finally {
      cleanup();
    }
  });

  it.each([
    ['commitMessage', '"chore({repo}): {title}"'],
    ['pullRequestTitle', '"[{key}] {title}"'],
    ['pullRequestDescription', '"Ticket: {id}"'],
  ])('allows %s to be configured independently', (field, value) => {
    const { path, cleanup } = fixture(`${VALID}\nconventions:\n  ${field}: ${value}\n`);
    try {
      expect(loadManifest(path).conventions).toEqual({ [field]: value.slice(1, -1) });
    } finally {
      cleanup();
    }
  });

  it('rejects a non-mapping section', () => {
    const { path, cleanup } = fixture(`${VALID}\nconventions: configured\n`);
    try {
      expect(() => loadManifest(path)).toThrow(/conventions must be a mapping/);
    } finally {
      cleanup();
    }
  });

  it.each([
    ['commitMessage', '42', /conventions\.commitMessage must be a string/],
    ['pullRequestTitle', '"   "', /conventions\.pullRequestTitle.*blank/],
    ['pullRequestDescription', 'false', /conventions\.pullRequestDescription must be a string/],
  ])('rejects invalid %s values with the exact path', (field, value, error) => {
    const { path, cleanup } = fixture(`${VALID}\nconventions:\n  ${field}: ${value}\n`);
    try {
      expect(() => loadManifest(path)).toThrow(error);
    } finally {
      cleanup();
    }
  });

  it('rejects unknown and malformed variables with the exact path', () => {
    const unknown = fixture(`${VALID}\nconventions:\n  pullRequestTitle: "{ticket}: {title}"\n`);
    try {
      expect(() => loadManifest(unknown.path)).toThrow(
        /conventions\.pullRequestTitle.*\{ticket\}/,
      );
    } finally {
      unknown.cleanup();
    }

    const malformed = fixture(`${VALID}\nconventions:\n  commitMessage: "fix: {title"\n`);
    try {
      expect(() => loadManifest(malformed.path)).toThrow(
        /conventions\.commitMessage.*malformed/,
      );
    } finally {
      malformed.cleanup();
    }
  });

  it('loads a branch template and a default type', () => {
    const { path, cleanup } = fixture(
      `${VALID}\nconventions:\n  branchName: "{type}/{key}-{title}"\n  defaultType: fix\n`,
    );
    try {
      expect(loadManifest(path).conventions).toEqual({
        branchName: '{type}/{key}-{title}',
        defaultType: 'fix',
      });
    } finally {
      cleanup();
    }
  });

  it.each([
    ['branchName: 42', /conventions\.branchName must be a string/],
    ['branchName: "   "', /conventions\.branchName.*blank/],
    ['branchName: "{repo}/{slug}"', /conventions\.branchName.*\{repo\}/],
    ['branchName: "karst/{slug"', /conventions\.branchName.*malformed/],
    ['branchName: "karst/{type}"', /conventions\.branchName.*\{slug\}/],
    ['defaultType: 7', /conventions\.defaultType must be a string/],
    ['defaultType: feature', /conventions\.defaultType must be one of/],
  ])('rejects %s', (line, error) => {
    const { path, cleanup } = fixture(`${VALID}\nconventions:\n  ${line}\n`);
    try {
      expect(() => loadManifest(path)).toThrow(error);
    } finally {
      cleanup();
    }
  });

  it('rejects description outside the pull-request description', () => {
    const { path, cleanup } = fixture(
      `${VALID}\nconventions:\n  commitMessage: "{description}"\n`,
    );
    try {
      expect(() => loadManifest(path)).toThrow(
        /conventions\.commitMessage.*\{description\}/,
      );
    } finally {
      cleanup();
    }
  });
});

describe('notices channel', () => {
  it('reports inert keys as notices, not warnings', () => {
    const yaml = `${VALID}\nuat:\n  maxFixAttempts: 2\n  secrets: [STRIPE_KEY]\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      const { notices, warnings } = loadManifestWithDiagnostics(path);
      expect(notices.some((n) => n.includes('uat.secrets'))).toBe(true);
      // Inactive is not the same claim as wrong.
      expect(warnings).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('warns when a uat.env value looks like a credential', () => {
    const yaml = `${VALID}\nuat:\n  env:\n    STRIPE_KEY: sk_live_abcdefghijklmnopqrstuvwx\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      const { warnings } = loadManifestWithDiagnostics(path);
      expect(warnings.some((w) => w.includes('uat.env') && w.includes('uat.secrets'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('has no notices for a manifest declaring only wired keys', () => {
    const yaml = `${VALID}\nreview:\n  maxFixAttempts: 2\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(loadManifestWithDiagnostics(path).notices).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe('placeholder transforms in manifest templates', () => {
  it('accepts a valid transform in every template field', () => {
    const { path, cleanup } = fixture(
      `${VALID}\nticketLabelTemplate: "{key|slice:-4} — {title|truncate:40}"\n` +
        `terminalNameTemplate: "Karst: {key|slice:-4}"\n` +
        `conventions:\n  branchName: "karst/{type}/{key|slice:-4}"\n` +
        `  commitMessage: "{type}({scope}): {title} [{key|slice:-4}]"\n` +
        `  pullRequestTitle: "{title|truncate:60}"\n` +
        `  pullRequestDescription: "{description|default:No summary.}"\n`,
    );
    try {
      const manifest = loadManifest(path);
      expect(manifest.ticketLabelTemplate).toBe('{key|slice:-4} — {title|truncate:40}');
      expect(manifest.conventions?.branchName).toBe('karst/{type}/{key|slice:-4}');
    } finally {
      cleanup();
    }
  });

  it('rejects an unknown transform in ticketLabelTemplate, naming the placeholder', () => {
    const { path, cleanup } = fixture(`${VALID}\nticketLabelTemplate: "{key|slize:-4}"\n`);
    try {
      expect(() => loadManifest(path)).toThrow(
        /ticketLabelTemplate contains unknown transform "slize" in "\{key\|slize:-4\}"/,
      );
    } finally {
      cleanup();
    }
  });

  it('rejects an unknown transform in terminalNameTemplate', () => {
    const { path, cleanup } = fixture(`${VALID}\nterminalNameTemplate: "{key|nope}"\n`);
    try {
      expect(() => loadManifest(path)).toThrow(
        /terminalNameTemplate contains unknown transform "nope"/,
      );
    } finally {
      cleanup();
    }
  });

  it('rejects a malformed argument in conventions.branchName', () => {
    const { path, cleanup } = fixture(
      `${VALID}\nconventions:\n  branchName: "karst/{key|slice:x}"\n`,
    );
    try {
      expect(() => loadManifest(path)).toThrow(
        /conventions\.branchName has an invalid "slice" argument in "\{key\|slice:x\}": start must be an integer/,
      );
    } finally {
      cleanup();
    }
  });

  it('rejects a malformed argument in conventions.commitMessage', () => {
    const { path, cleanup } = fixture(
      `${VALID}\nconventions:\n  commitMessage: "{title|truncate:0}"\n`,
    );
    try {
      expect(() => loadManifest(path)).toThrow(
        /conventions\.commitMessage has an invalid "truncate" argument in "\{title\|truncate:0\}"/,
      );
    } finally {
      cleanup();
    }
  });
});

describe('process assignments', () => {
  const WITH_PROCESSES = `
host: localhost
portRange: [4000, 4999]
baselineBranch: develop
repositories:
  api:
    repoPath: ../api
agents:
  uat-author: { role: uat }
processes:
  uatTester:
    agent: uat-author
    agentName: My UAT Agent
    provider: codex
    model: gpt-5.6-sol
    instructions: Focus on API behavior.
    enabled: false
  review:
    provider: antigravity
  ticketAnalysis:
    provider: opencode
    model: gemini-2.5-pro
`;

  it('loads a processes block into the typed model', () => {
    const { path, cleanup } = fixture(WITH_PROCESSES);
    try {
      expect(loadManifest(path).processes).toEqual({
        uatTester: {
          agent: 'uat-author',
          agentName: 'My UAT Agent',
          provider: 'codex',
          model: 'gpt-5.6-sol',
          // The fixture declares a legacy `instructions:` — retired, so it is
          // dropped rather than typed (the load still succeeds; `inertKeys.ts`
          // reports it).
          enabled: false,
        },
        review: { provider: 'antigravity', enabled: true },
        ticketAnalysis: { provider: 'opencode', model: 'gemini-2.5-pro', enabled: true },
      });
    } finally {
      cleanup();
    }
  });

  it('leaves processes undefined when the block is absent', () => {
    const { path, cleanup } = fixture(VALID);
    try {
      expect(loadManifest(path).processes).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('rejects an unknown process key, naming it and the closed vocabulary', () => {
    const yaml = WITH_PROCESSES.replace(
      '  review:\n    provider: antigravity',
      '  wibble:\n    provider: codex',
    );
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/processes "wibble" is not a known inside process/);
    } finally {
      cleanup();
    }
  });

  it('accepts an agent reference not declared in the agents block (a pool/file agent)', () => {
    const yaml = WITH_PROCESSES.replace('agent: uat-author', 'agent: description-improver');
    const { path, cleanup } = fixture(yaml);
    try {
      const m = loadManifest(path);
      expect(m.processes?.uatTester?.agent).toBe('description-improver');
    } finally {
      cleanup();
    }
  });

  it('rejects an unknown provider, naming the field', () => {
    const yaml = WITH_PROCESSES.replace('provider: codex', 'provider: copilot');
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/processes\.uatTester\.provider/);
    } finally {
      cleanup();
    }
  });

  it('rejects a malformed assignment, naming the field', () => {
    const yaml = WITH_PROCESSES.replace('    enabled: false', '    enabled: "yes"');
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/processes\.uatTester\.enabled must be a boolean/);
    } finally {
      cleanup();
    }
  });
});

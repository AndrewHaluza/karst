import { describe, it, expect } from 'vitest';
import {
  SETTINGS_SECTIONS,
  SECTION_FIELDS,
  SECTION_LABELS,
  isSettingsSection,
  mergeSection,
} from './sections.js';
import type { Manifest } from '../../manifest/types.js';
import { manifest as buildManifest, runnableRepo, slot } from '../../manifest/fixtures.js';

const BASE: Manifest = buildManifest(
  { api: runnableRepo({ ports: [slot('port', 'PORT', 3000)] }, { repoPath: '../api', signals: [] }) },
  {
    host: 'localhost',
    portRange: [4000, 4999],
    baselineBranch: 'main',
    approaches: [{ id: 'a', label: 'A' }],
    agents: {},
    worktreePathDisplay: 'relative',
    ticketing: { provider: 'manual' },
    conventions: { branchName: 'karst/{slug}' },
  },
);

describe('settings sections — vocabulary', () => {
  it('gives every section a label', () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(SECTION_LABELS[section]).toBeTruthy();
    }
  });

  it('assigns every editable manifest field to exactly one section', () => {
    const seen = new Set<string>();
    for (const section of SETTINGS_SECTIONS) {
      for (const field of SECTION_FIELDS[section]) {
        expect(seen.has(field), `${field} claimed twice`).toBe(false);
        seen.add(field);
      }
    }
    // Every field the settings page can edit must be owned, or a tab-scoped Save
    // would silently drop it.
    expect([...seen].sort()).toEqual(
      [
        'agentProvider',
        'agents',
        'approaches',
        'baselineBranch',
        'conventions',
        'defaultModel',
        'host',
        'portRange',
        'repositories',
        'terminalNameTemplate',
        'ticketLabelTemplate',
        'ticketing',
        'worktreePathDisplay',
      ].sort(),
    );
  });

  it('narrows an untrusted section name', () => {
    expect(isSettingsSection('general')).toBe(true);
    expect(isSettingsSection('constructor')).toBe(false);
    expect(isSettingsSection(undefined)).toBe(false);
    expect(isSettingsSection(7)).toBe(false);
  });
});

describe('settings sections — mergeSection', () => {
  it('takes only the named section from the incoming draft', () => {
    const incoming: Manifest = {
      ...BASE,
      host: '0.0.0.0', // general — kept
      baselineBranch: 'develop', // general — kept
      repositories: {}, // services — must NOT be taken
      conventions: { branchName: 'other/{slug}' }, // git — must NOT be taken
    };
    const merged = mergeSection(BASE, incoming, 'general');

    expect(merged.host).toBe('0.0.0.0');
    expect(merged.baselineBranch).toBe('develop');
    expect(merged.repositories).toEqual(BASE.repositories);
    expect(merged.conventions).toEqual(BASE.conventions);
  });

  it('removes a section field the draft cleared', () => {
    const withTemplate: Manifest = { ...BASE, ticketLabelTemplate: '{key}' };
    const { ticketLabelTemplate: _dropped, ...cleared } = withTemplate;
    const merged = mergeSection(withTemplate, cleared as Manifest, 'general');

    expect('ticketLabelTemplate' in merged).toBe(false);
  });

  it('preserves fields no section owns (uat, id)', () => {
    const base: Manifest = {
      ...BASE,
      id: 'karst',
      uat: {
        maxFixAttempts: 2,
        env: {},
        secrets: [],
        passthrough: [],
        origins: [],
        repositories: {},
      },
    };
    const merged = mergeSection(base, { ...BASE, host: '0.0.0.0' }, 'general');

    expect(merged.id).toBe('karst');
    expect(merged.uat).toEqual(base.uat);
  });

  it('never mutates either input', () => {
    const baseCopy = JSON.parse(JSON.stringify(BASE));
    const incoming: Manifest = { ...BASE, host: '0.0.0.0' };
    const incomingCopy = JSON.parse(JSON.stringify(incoming));
    mergeSection(BASE, incoming, 'general');

    expect(BASE).toEqual(baseCopy);
    expect(incoming).toEqual(incomingCopy);
  });
});

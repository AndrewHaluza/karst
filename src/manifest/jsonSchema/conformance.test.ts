import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { unsupportedKeywords } from '../../cli/jsonSchema.js';
import { foldProcessRows } from '../foldProcessRows.js';
import { migrateLegacyManifest } from '../migrate.js';
import { schemaError, validatorError } from './fixtures/harness.js';
import { MANIFEST_SECTION_SCHEMAS } from './index.js';
import { agentPresets, graphApproach, manifest, processes, review, runnableRepo, stack, uat } from '../fixtures.js';
import { richDraftManifest, richManifest, type Raw } from './fixtures/richManifest.js';

function prepared(text: string): unknown {
  const { raw: migrated } = migrateLegacyManifest(yamlLoad(text));
  return foldProcessRows(migrated).raw;
}

describe('manifest section schemas', () => {
  it('use only keywords the CLI subset supports', () => {
    for (const [section, schema] of Object.entries(MANIFEST_SECTION_SCHEMAS)) {
      expect(unsupportedKeywords(schema), section).toEqual([]);
    }
  });

  it('agree with the validator on the rich manifest and its draft variant', () => {
    for (const raw of [richManifest(), richDraftManifest()]) {
      expect(validatorError(raw)).toBeNull();
      expect(schemaError(raw)).toBeNull();
    }
  });

  it('agree with the validator on karst.example.yml', () => {
    const text = readFileSync(join(process.cwd(), 'karst.example.yml'), 'utf8');
    const raw = prepared(text) as Raw;
    expect(validatorError(raw)).toBeNull();
    expect(schemaError(raw)).toBeNull();
  });
});

import { mutationsOf } from './fixtures/mutations.js';

/**
 * Messages of the cross-field rules a schema cannot express (see
 * `VALIDATOR_ONLY_RULES`). The validator may refuse a document the schema accepts
 * ONLY with one of these messages.
 */
const VALIDATOR_ONLY_MESSAGES: readonly RegExp[] = [
  /needs a loopback host/,
  /portRange min \(.*\) exceeds max/,
  /must include one of \{slug\}, \{key\} or \{id\}/,
  /is not a declared repository/,
  /runs in another place/,
  /targets unknown repository/,
  /declares no service/,
  /has no such port slot/,
  /must be at least maxReplans \+ 1/,
  /names no agent preset/,
  /no greater than review\.maxFixAttempts/,
];

/**
 * Fields the validator reads loosely: it accepts ANY value, treating a non-boolean
 * as "not set". The schema is stricter on purpose, so a setup tool writes a real
 * boolean. Matched against the dotted path with indexes replaced by `N`.
 */
const LENIENT_FIELDS: readonly string[] = [
  'repositories.*.enabled',
  'repositories.*.hasMigrations',
  'approaches.N.enabled',
  'approaches.N.recommended',
  'agents.*.enabled',
  'uat.author.enabled',
];

function generic(path: string): string {
  return path
    .split('.')
    .map((part, i, all) => (/^\d+$/.test(part) ? 'N' : part))
    .join('.');
}

function isLenient(path: string): boolean {
  const g = generic(path);
  return LENIENT_FIELDS.some((pattern) => new RegExp(`^${pattern.replace(/\./g, '\\.').replace('*', '[^.]+')}$`).test(g));
}

describe('schema and validator agree on the cookbook and the fixtures', () => {
  it('karst.example.yml with the cookbook repositories uncommented', () => {
    const lines = readFileSync(join(process.cwd(), 'karst.example.yml'), 'utf8').split('\n');
    const begin = lines.indexOf('# COOKBOOK-REPOS-BEGIN');
    const end = lines.indexOf('# COOKBOOK-REPOS-END');
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    const body = lines.slice(begin + 1, end).map((l) => l.replace(/^# ?/, ''));
    const raw = prepared([...lines.slice(0, begin), ...body, ...lines.slice(end + 1)].join('\n'));
    expect(validatorError(raw)).toBeNull();
    expect(schemaError(raw)).toBeNull();
  });

  const repos = { api: runnableRepo({}, { repoPath: '/work/api' }), web: runnableRepo({}, { repoPath: '/work/web' }) };
  const asRaw = (m: unknown): Raw => m as Raw;
  const FIXTURES: readonly [string, Raw][] = [
    ['runnable repositories', asRaw(manifest(repos))],
    ['uat and review', asRaw(manifest(repos, { uat: uat(), review: review() }))],
    ['process rows', asRaw(manifest(repos, { processes: processes() }))],
    ['agent presets', asRaw(manifest(repos, { agentPresets: agentPresets() }))],
    ['graph approach', asRaw(manifest(repos, { approaches: [graphApproach()] }))],
    ['stack', asRaw(manifest(stack()))],
  ];

  it('most fixtures are valid manifests, so the agreement is not only about refusals', () => {
    expect(FIXTURES.filter(([, raw]) => validatorError(raw) === null).length).toBeGreaterThanOrEqual(5);
  });

  it.each(FIXTURES.map(([name, raw]) => ({ name, raw })))('fixture $name: both accept or both refuse', ({ raw }) => {
    expect(schemaError(raw) === null).toBe(validatorError(raw) === null);
  });
});

describe('schema and validator agree on every mutation', () => {
  for (const [label, base] of [['rich', richManifest()], ['draft', richDraftManifest()]] as const) {
    it(`${label} manifest: each field mutation is accepted by both or refused by both`, () => {
      const disagreements: string[] = [];
      for (const m of mutationsOf(base)) {
        const vError = validatorError(m.document);
        const sError = schemaError(m.document);
        if ((vError === null) === (sError === null)) continue;
        if (vError !== null && sError === null && VALIDATOR_ONLY_MESSAGES.some((re) => re.test(vError))) continue;
        if (vError === null && sError !== null && isLenient(m.path)) continue;
        disagreements.push(`${m.path} [${m.how}]: validator ${vError ?? 'accepts'} | schema ${sError ?? 'accepts'}`);
      }
      expect(disagreements).toEqual([]);
    });
  }
});

describe('the allowed disagreements are real', () => {
  const found = (() => {
    const messages = new Set<RegExp>();
    const lenient = new Set<string>();
    for (const base of [richManifest(), richDraftManifest()]) {
      for (const m of mutationsOf(base)) {
        const vError = validatorError(m.document);
        const sError = schemaError(m.document);
        if (vError !== null && sError === null) {
          for (const re of VALIDATOR_ONLY_MESSAGES) if (re.test(vError)) messages.add(re);
        }
        if (vError === null && sError !== null) {
          for (const pattern of LENIENT_FIELDS) if (isLenient(m.path) && generic(m.path).includes(pattern.split('*').pop()!)) lenient.add(pattern);
        }
      }
    }
    return { messages, lenient };
  })();

  it.each(VALIDATOR_ONLY_MESSAGES.map((re) => ({ re })))('validator-only message $re is produced', ({ re }) => {
    expect(found.messages.has(re)).toBe(true);
  });

  it.each(LENIENT_FIELDS.map((field) => ({ field })))('lenient field $field is accepted loosely by the validator', ({ field }) => {
    expect(found.lenient.has(field)).toBe(true);
  });
});

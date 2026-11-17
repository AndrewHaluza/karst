import type { JsonSchema } from '../../cli/jsonSchema.js';
import { MAX_HEALTH_TIMEOUT_SECONDS } from '../types.js';
import {
  BOOLEAN,
  NEVER,
  NON_EMPTY_STRING,
  TRIMMED_STRING,
  PORT,
  RELATIVE_PATH,
  STRING,
  arrayOf,
  enumOf,
  integer,
  lenientObject,
  orNull,
  ref,
  strictObject,
  stringMap,
} from './shared.js';

/** Runtime fields that belong under `service:` and are refused on the repository itself. */
const REPOSITORY_RUNTIME_KEYS = [
  'start',
  'health',
  'healthIdentity',
  'healthTimeoutSeconds',
  'ports',
  'dependsOn',
  'portRange',
  'docker',
  'cwd',
] as const;

const SERVICE_NAME_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]*$';

/** A relative path inside the worktree: no leading `/`, `\`, drive letter, or `..` segment. */
const WORKTREE_PATH: JsonSchema = {
  type: 'string',
  pattern: '^(?![/\\\\])(?![A-Za-z]:)(?!.*(^|[/\\\\])\\.\\.([/\\\\]|$))',
};

const SERVICE_COMMON: Record<string, JsonSchema> = {
  health: STRING,
  reset: STRING,
  cwd: WORKTREE_PATH,
  healthIdentity: BOOLEAN,
  healthTimeoutSeconds: integer(1, MAX_HEALTH_TIMEOUT_SECONDS),
  sandbox: enumOf(['host', 'inside']),
  ports: arrayOf(
    lenientObject({ name: NON_EMPTY_STRING, env: NON_EMPTY_STRING, default: PORT }, [
      'name',
      'env',
      'default',
    ]),
    { minItems: 1 },
  ),
  portRange: arrayOf(PORT, { minItems: 2, maxItems: 2 }),
  dependsOn: orNull(
    arrayOf(
      lenientObject(
        {
          target: TRIMMED_STRING,
          port: TRIMMED_STRING,
          bind: arrayOf(
            lenientObject({ env: NON_EMPTY_STRING, template: NON_EMPTY_STRING }, ['env', 'template']),
            {
              minItems: 1,
            },
          ),
        },
        ['target', 'port', 'bind'],
      ),
    ),
  ),
};

const DOCKER = lenientObject(
  {
    image: NON_EMPTY_STRING,
    containerPort: PORT,
    env: stringMap(),
    volumes: arrayOf({ type: 'string', pattern: '^\\s*[^:]+:/[^:]*' }),
    args: arrayOf(NON_EMPTY_STRING),
  },
  ['image', 'containerPort'],
);

/** Start XOR docker: exactly one of the two says how the service runs. */
const SERVICE: JsonSchema = {
  oneOf: [
    lenientObject({ ...SERVICE_COMMON, start: NON_EMPTY_STRING, docker: NEVER }, ['start', 'ports']),
    lenientObject(
      {
        ...SERVICE_COMMON,
        start: { type: 'string', pattern: '^\\s*$' },
        docker: ref('docker'),
      },
      ['docker', 'ports'],
    ),
  ],
};

/** A disabled (draft) repository's service: shape only, the strict rules are relaxed. */
const DRAFT_SERVICE: JsonSchema = lenientObject(
  {
    ...SERVICE_COMMON,
    start: STRING,
    docker: { type: 'object' },
    ports: arrayOf(lenientObject({ name: STRING, env: STRING, default: { type: 'number' } })),
    portRange: arrayOf({ type: 'number' }, { minItems: 2, maxItems: 2 }),
    dependsOn: orNull(
      arrayOf(
        lenientObject(
          {
            target: STRING,
            port: STRING,
            bind: arrayOf(lenientObject({ env: STRING, template: STRING })),
          },
          ['bind'],
        ),
      ),
    ),
  },
  ['ports'],
);

const REPO_CONVENTIONS = lenientObject({
  commitMessage: TRIMMED_STRING,
  pullRequestTitle: TRIMMED_STRING,
  pullRequestDescription: TRIMMED_STRING,
  branchName: NEVER,
  defaultType: NEVER,
});

const SHIP = lenientObject({
  exclude: arrayOf({ type: 'string', minLength: 1, pattern: '^[^:]' }),
  regenerate: arrayOf({
    anyOf: [
      NON_EMPTY_STRING,
      lenientObject(
        {
          run: NON_EMPTY_STRING,
          sandbox: { const: 'host' },
          paths: arrayOf(RELATIVE_PATH),
        },
        ['run'],
      ),
    ],
  }),
});

const SANDBOX = lenientObject(
  {
    setup: NON_EMPTY_STRING,
    setupHosts: arrayOf(TRIMMED_STRING, { minItems: 1 }),
  },
  ['setup'],
);

const GRAPH_PATH: JsonSchema = {
  type: 'string',
  minLength: 1,
  pattern: '^(?![/\\\\])(?![A-Za-z]:)(?!\\.git(/|$))(?!.*(^|[/\\\\])\\.\\.([/\\\\]|$))',
};

const GRAPH_WORKSPACE = strictObject({
  link: arrayOf(GRAPH_PATH),
  setup: NON_EMPTY_STRING,
  setupWhen: arrayOf(GRAPH_PATH),
});

function repositoryProperties(draft: boolean, shape: 'service' | 'services'): Record<string, JsonSchema> {
  const runtimeGuards = Object.fromEntries(REPOSITORY_RUNTIME_KEYS.map((key) => [key, NEVER]));
  const service = draft ? DRAFT_SERVICE : ref('service');
  const services: JsonSchema = {
    type: 'object',
    propertyNames: { type: 'string', pattern: SERVICE_NAME_PATTERN },
    additionalProperties: service,
    ...(draft ? {} : { minProperties: 1 }),
  };
  return {
    ...runtimeGuards,
    repoPath: draft ? STRING : NON_EMPTY_STRING,
    baselineBranch: STRING,
    scope: STRING,
    hasMigrations: BOOLEAN,
    signals: arrayOf(NON_EMPTY_STRING),
    enabled: draft ? { const: false } : { const: true },
    conventions: REPO_CONVENTIONS,
    sandbox: SANDBOX,
    graphWorkspace: GRAPH_WORKSPACE,
    ship: SHIP,
    service: shape === 'service' ? service : NEVER,
    services: shape === 'services' ? services : NEVER,
  };
}

/** A repository is enabled and complete, or a disabled draft; `service` and `services` never both. */
function repositoryVariant(draft: boolean, shape: 'service' | 'services'): JsonSchema {
  const properties = repositoryProperties(draft, shape);
  const base = lenientObject(properties, draft ? ['enabled'] : ['repoPath']);
  return base;
}

const REPOSITORY: JsonSchema = {
  anyOf: [
    repositoryVariant(false, 'service'),
    repositoryVariant(false, 'services'),
    repositoryVariant(true, 'service'),
    repositoryVariant(true, 'services'),
  ],
};

/**
 * Repositories tab. Validator-only (not expressible here): case-insensitive
 * distinct repository ids, `dependsOn` targets and ports, unique port names/envs
 * and bind envs, a service not depending on itself, `portRange` min <= max, the
 * `validateGraph` rules, host placement across `dependsOn`, shared-repo baseline
 * branches, and the `sandbox.setupHosts` grammar.
 */
export const REPOSITORIES_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['repositories'],
  $defs: { service: SERVICE, docker: DOCKER },
  properties: {
    repositories: {
      type: 'object',
      minProperties: 1,
      additionalProperties: REPOSITORY,
    },
  },
};

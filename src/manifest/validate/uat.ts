import { ManifestError } from '../error.js';
import type {
  UatAuthBootstrap,
  UatAuthor,
  UatConfig,
  UatGateDef,
  UatGateKind,
  UatRepositoryOverride,
} from '../types.js';

const GATE_KINDS: readonly UatGateKind[] = ['script', 'command'];

/** Value shapes that read as a pasted credential rather than a config literal. */
const CREDENTIAL_PREFIXES = ['sk_live_', 'sk_test_', 'ghp_', 'AKIA', 'SG.'];
const HIGH_ENTROPY = /^[A-Za-z0-9_\-+/=]{32,}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringMap(raw: unknown, where: string): Record<string, string> {
  if (raw === undefined) return {};
  if (!isObject(raw)) throw new ManifestError(`${where} must be a mapping`);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') {
      throw new ManifestError(`${where} "${key}" must be a string`);
    }
    out[key] = value;
  }
  return out;
}

/**
 * A list of bare key NAMES.
 *
 * Strict where the rest of `schema.ts` is permissive, and deliberately so: house
 * style hand-picks known fields and ignores the rest, which is inert everywhere
 * else. Here an ignored key means a live credential committed to git, because
 * `karst.yml` is a committed file. A mapping — or a list entry carrying a value —
 * is refused with the field named rather than quietly dropped.
 */
function keyNameList(raw: unknown, where: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ManifestError(`${where} must be a list of key names, never a mapping with values`);
  }
  return raw.map((entry) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new ManifestError(`${where} must be a list of key names, never a mapping with values`);
    }
    return entry;
  });
}

function validateGate(raw: unknown, index: number): UatGateDef {
  if (!isObject(raw)) throw new ManifestError(`uat.gates[${index}] must be a mapping`);
  const name = raw.name;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new ManifestError(`uat.gates[${index}].name must be a non-empty string`);
  }
  const kind = raw.kind;
  if (typeof kind !== 'string' || !GATE_KINDS.includes(kind as UatGateKind)) {
    throw new ManifestError(`uat.gates "${name}".kind must be one of: ${GATE_KINDS.join(', ')}`);
  }
  const gate: UatGateDef = { name, kind: kind as UatGateKind };

  if (kind === 'script') {
    if (typeof raw.script !== 'string' || raw.script.trim().length === 0) {
      throw new ManifestError(`uat.gates "${name}".script must be a non-empty string`);
    }
    gate.script = raw.script;
  } else {
    // argv-based and spawned without a shell, so there is no quoting surface.
    // This is `kind: script`'s sibling, not a scripting language — it is what
    // keeps UAT usable by Go, Rust, Java and Python repositories.
    if (typeof raw.command !== 'string' || raw.command.trim().length === 0) {
      throw new ManifestError(`uat.gates "${name}".command must be a non-empty string`);
    }
    gate.command = raw.command;
    if (raw.args !== undefined) {
      if (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== 'string')) {
        throw new ManifestError(`uat.gates "${name}".args must be a list of strings`);
      }
      gate.args = raw.args as string[];
    }
  }

  if (raw.repo !== undefined) {
    if (typeof raw.repo !== 'string') {
      throw new ManifestError(`uat.gates "${name}".repo must be a string`);
    }
    gate.repo = raw.repo;
  }
  if (raw.report !== undefined) {
    if (typeof raw.report !== 'string') {
      throw new ManifestError(`uat.gates "${name}".report must be a string`);
    }
    gate.report = raw.report;
  }
  return gate;
}

function validateGates(raw: unknown): UatGateDef[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new ManifestError('uat.gates must be a list');
  return raw.map(validateGate);
}

function validateOrigins(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ManifestError('uat.origins must be a list');
  return raw.map((entry) => {
    if (typeof entry !== 'string') throw new ManifestError('uat.origins must be a list of URLs');
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new ManifestError(`uat.origins "${entry}" must be an absolute URL with a scheme`);
    }
    // A non-special scheme (no host) parses without throwing but yields the
    // opaque origin "null" — e.g. "localhost:5173" reads as scheme "localhost:"
    // with path "5173", not as a host. Reject that rather than smuggle it through.
    if (url.origin === 'null') {
      throw new ManifestError(`uat.origins "${entry}" must be an absolute URL with a scheme`);
    }
    // Compared as parsed scheme + host + port, never as a prefix, so
    // "https://api.stripe.com" cannot match "https://api.stripe.com.evil.test".
    return url.origin;
  });
}

function validateAuthBootstrap(raw: unknown): UatAuthBootstrap | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new ManifestError('uat.authBootstrap must be a mapping');
  if (typeof raw.path !== 'string' || raw.path.trim().length === 0) {
    throw new ManifestError('uat.authBootstrap.path must be a non-empty string');
  }
  return { path: raw.path, secrets: keyNameList(raw.secrets, 'uat.authBootstrap.secrets') };
}

function validateAuthor(raw: unknown): UatAuthor | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new ManifestError('uat.author must be a mapping');
  const author: UatAuthor = { enabled: raw.enabled !== false };
  if (raw.agent !== undefined) {
    if (typeof raw.agent !== 'string') throw new ManifestError('uat.author.agent must be a string');
    author.agent = raw.agent;
  }
  return author;
}

function validateRepositories(raw: unknown): Record<string, UatRepositoryOverride> {
  if (raw === undefined) return {};
  if (!isObject(raw)) throw new ManifestError('uat.repositories must be a mapping');
  const out: Record<string, UatRepositoryOverride> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isObject(value)) throw new ManifestError(`uat.repositories "${name}" must be a mapping`);
    const override: UatRepositoryOverride = {};
    if (value.env !== undefined) override.env = stringMap(value.env, `uat.repositories "${name}".env`);
    if (value.secrets !== undefined) {
      override.secrets = keyNameList(value.secrets, `uat.repositories "${name}".secrets`);
    }
    if (value.gates !== undefined) override.gates = validateGates(value.gates);
    if (value.testDir !== undefined) {
      if (typeof value.testDir !== 'string') {
        throw new ManifestError(`uat.repositories "${name}".testDir must be a string`);
      }
      override.testDir = value.testDir;
    }
    out[name] = override;
  }
  return out;
}

/** Parse the optional `uat:` block. Absent yields the default pipeline. */
export function validateUat(raw: unknown): UatConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new ManifestError('uat must be a mapping');

  let maxFixAttempts = 3;
  if (raw.maxFixAttempts !== undefined) {
    if (typeof raw.maxFixAttempts !== 'number' || !Number.isInteger(raw.maxFixAttempts) || raw.maxFixAttempts < 1) {
      throw new ManifestError('uat.maxFixAttempts must be a positive integer');
    }
    maxFixAttempts = raw.maxFixAttempts;
  }

  const config: UatConfig = {
    maxFixAttempts,
    env: stringMap(raw.env, 'uat.env'),
    secrets: keyNameList(raw.secrets, 'uat.secrets'),
    passthrough: keyNameList(raw.passthrough, 'uat.passthrough'),
    origins: validateOrigins(raw.origins),
    repositories: validateRepositories(raw.repositories),
  };

  if (raw.testDir !== undefined) {
    if (typeof raw.testDir !== 'string') throw new ManifestError('uat.testDir must be a string');
    config.testDir = raw.testDir;
  }
  const gates = validateGates(raw.gates);
  if (gates !== undefined) config.gates = gates;
  const authBootstrap = validateAuthBootstrap(raw.authBootstrap);
  if (authBootstrap !== undefined) config.authBootstrap = authBootstrap;
  const author = validateAuthor(raw.author);
  if (author !== undefined) config.author = author;

  return config;
}

/**
 * Values in `uat.env` that look like credentials.
 *
 * A warning, never a block, and deliberately outside the validator: it cannot be
 * reliable, and the mistake it catches is the likely one — pasting a value into
 * the wrong block. The host surfaces these; loading never fails on them.
 */
export function uatEnvWarnings(config: UatConfig): string[] {
  return Object.entries(config.env).flatMap(([key, value]) =>
    CREDENTIAL_PREFIXES.some((p) => value.startsWith(p)) || HIGH_ENTROPY.test(value)
      ? [`uat.env "${key}" looks like a credential — declare it under uat.secrets instead`]
      : [],
  );
}

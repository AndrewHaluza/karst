import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadManifestWithDiagnostics } from '../manifest/load.js';
import { validateSetupProposal, type ManifestProposal } from '../setup/proposal.js';
import { resolveSetupOutboxDir, writeSetupProposal } from '../setup/outbox.js';

/**
 * `karst manifest validate --file <path>` and `karst manifest propose --file <path>`.
 *
 * `validate` runs the SAME loader + schema the extension uses, so a draft the
 * agent believes is valid cannot fail later at the host boundary; it prints the
 * parsed identity and repository count as JSON.
 *
 * `propose` validates first, then writes a `kind: 'manifest'` proposal into
 * `$KARST_SETUP_OUTBOX` — the raw YAML plus its target path. The extension
 * ingests it, diffs it against the current file, and applies it only after the
 * user approves. The agent NEVER writes `karst.yml` itself.
 *
 * Its own parse path (handled before structured input in `main.ts`) because
 * `--file` here names a YAML file, not a JSON structured-input payload.
 */

export interface ManifestCommandDeps {
  /** `KARST_SETUP_OUTBOX` from the session env, read and injected by main.ts. */
  outboxEnv?: string;
  /** Injectable uuid for deterministic tests. */
  uuid?: () => string;
}

const USAGE = 'usage: karst manifest <validate|propose> --file <path> [--summary <text>]';

interface Parsed {
  sub: 'validate' | 'propose';
  file: string;
  summary?: string;
}

export function parseManifestArgs(argv: readonly string[]): Parsed {
  const [cmd, sub, ...rest] = argv;
  if (cmd !== 'manifest') throw new Error(`karst manifest: unknown command '${cmd ?? ''}'`);
  if (sub !== 'validate' && sub !== 'propose') {
    throw new Error(`karst manifest: unknown subcommand '${sub ?? ''}' (want 'validate' or 'propose')`);
  }
  let file: string | undefined;
  let summary: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === '--file') {
      file = rest[++i];
      if (file === undefined) throw new Error(`karst manifest ${sub}: --file needs a path (${USAGE})`);
    } else if (token === '--summary') {
      summary = rest[++i];
      if (summary === undefined) throw new Error(`karst manifest ${sub}: --summary needs a value (${USAGE})`);
    } else {
      throw new Error(`karst manifest ${sub}: unknown argument '${token}' (${USAGE})`);
    }
  }
  if (file === undefined) throw new Error(`karst manifest ${sub}: missing --file <path> (${USAGE})`);
  return { sub, file, summary };
}

function validateFile(file: string) {
  // Throws a ManifestError carrying the path on any malformed input — the same
  // failure the extension would hit, surfaced once, clearly.
  return loadManifestWithDiagnostics(file);
}

function runValidate(file: string): string {
  const { manifest, warnings, notices } = validateFile(file);
  return JSON.stringify({
    ok: true,
    id: manifest.id ?? null,
    repositories: Object.keys(manifest.repositories),
    warnings,
    notices,
  });
}

function runPropose(file: string, summary: string | undefined, deps: ManifestCommandDeps): string {
  const { manifest } = validateFile(file);
  const targetPath = resolve(file);
  const yaml = readFileSync(file, 'utf8');
  const serviceCount = Object.values(manifest.repositories).filter((r) => r.service !== undefined).length;
  const proposal: ManifestProposal = {
    kind: 'manifest',
    targetPath,
    yaml,
    summary:
      summary ??
      `Proposed manifest: ${Object.keys(manifest.repositories).length} repositories, ${serviceCount} with a service.`,
  };
  const checked = validateSetupProposal(proposal);
  if (!checked.ok) throw new Error(`karst manifest propose: ${checked.reason}`);

  const dir = resolveSetupOutboxDir(deps.outboxEnv);
  const out = writeSetupProposal(dir, checked.value, deps.uuid);
  return JSON.stringify({ ok: true, kind: 'manifest', file: out });
}

export function runManifestCommand(argv: readonly string[], deps: ManifestCommandDeps = {}): string {
  const { sub, file, summary } = parseManifestArgs(argv);
  return sub === 'validate' ? runValidate(file) : runPropose(file, summary, deps);
}

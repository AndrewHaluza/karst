import type { SessionRunner } from './sessionRunner.js';

/** What a launch gains inside an enforced sandbox: extra argv and an env rewrite. */
export interface AutonomousLaunch {
  /** True when the core runs without permission prompts (diagnostics: `autonomous`). */
  readonly autonomous: boolean;
  readonly args: string[];
  readonly env: (env: Readonly<Record<string, string>>) => Record<string, string>;
}

/** opencode permission keys that ask by default; `question` is a dialog, not a gate, so it stays. */
export const ALLOW_ALL_OPENCODE_PERMISSION = {
  edit: 'allow',
  bash: { '*': 'allow' },
  webfetch: 'allow',
  websearch: 'allow',
  external_directory: 'allow',
  doom_loop: 'allow',
} as const;

const PROMPTED: AutonomousLaunch = { autonomous: false, args: [], env: (env) => ({ ...env }) };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseObject(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Allow-all over an existing permission object. bash is last-match-wins, so
 * the catch-all allow goes first and karst's own bash denies (the process-kill
 * guard) stay after it.
 */
function relaxPermission(existing: unknown): Record<string, unknown> {
  const { '*': _catchAll, ...denies } = isRecord(existing) && isRecord(existing['bash']) ? existing['bash'] : {};
  return { ...ALLOW_ALL_OPENCODE_PERMISSION, bash: { '*': 'allow', ...denies } };
}

function opencodeAllowAll(env: Readonly<Record<string, string>>): Record<string, string> {
  const config = parseObject(env['OPENCODE_CONFIG_CONTENT']);
  const out: Record<string, string> = {
    ...env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, permission: relaxPermission(config['permission']) }),
  };
  // v1 reads its permission from this env, merged after every config file.
  if (env['OPENCODE_PERMISSION'] !== undefined) {
    out['OPENCODE_PERMISSION'] = JSON.stringify(relaxPermission(parseObject(env['OPENCODE_PERMISSION'])));
  }
  return out;
}

/**
 * The ONE place sandbox relaxation lives (arch:AC-31, fail closed): nothing
 * unless the runner ITSELF enforces a sandbox, so a host runner never gets a
 * bypass flag or an allow-all config. Delivered through the launch (argv/env),
 * never written to the worktree or the host opencode config.
 */
export function autonomousLaunch(core: string, runner: Pick<SessionRunner, 'enforcesSandbox'>): AutonomousLaunch {
  if (runner.enforcesSandbox !== true) return PROMPTED;
  if (core === 'claude') return { autonomous: true, args: ['--dangerously-skip-permissions'], env: PROMPTED.env };
  if (core === 'codex') return { autonomous: true, args: ['-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"'], env: PROMPTED.env };
  if (core === 'opencode' || core === 'opencode2') return { autonomous: true, args: [], env: opencodeAllowAll };
  return PROMPTED;
}

/**
 * Guest side of an sbx launch through the host OAuth proxy (@arch:AC-51). The per-sandbox
 * key never appears in an argv: `sbx run --env ANTHROPIC_API_KEY` (a bare name) takes the
 * value from the client env, and the approval step reads it from the `sbx exec` client env.
 */
import { SANDBOX_HOST_ALIAS } from '../sandboxPorts.js';
import { hostPortResources } from './sbxPorts.js';

/** The env name the guest Claude reads its API key from. */
export const KEY_ENV = 'ANTHROPIC_API_KEY';
/** The env name that carries the key to the approval step (`sbx exec`), apart from the agent's own. */
export const APPROVAL_KEY_ENV = 'KARST_OAUTH_KEY';
/** Claude Code names an approved key by its last 20 characters. */
const APPROVED_SUFFIX = 20;

/** The guest reaches the host through the alias; `localhost` in the guest is the guest itself. */
export function oauthBaseUrl(port: number): string {
  return `http://${SANDBOX_HOST_ALIAS}:${port}`;
}

/** The `--env` pairs of `sbx run`: the base url as a pair, the key as a bare name (its value is in the client env). */
export function oauthLaunchArgs(port: number): string[] {
  return ['--env', `ANTHROPIC_BASE_URL=${oauthBaseUrl(port)}`, '--env', KEY_ENV];
}

/** `sbx policy` args for the proxy port; the HTTP request is matched as `localhost`, so both host forms go in. */
export function oauthPolicyArgs(verb: 'allow' | 'rm', name: string, port: number): string[] {
  const list = hostPortResources([port]).join(',');
  return verb === 'allow' ? ['policy', 'allow', 'network', '--sandbox', name, list] : ['policy', 'rm', 'network', '--sandbox', name, '--resource', list, '--force'];
}

/** Runs in the guest: add the key to `customApiKeyResponses.approved` in `~/.claude.json`, so Claude does not ask about it. */
const APPROVAL_SCRIPT = `node -e '
const fs = require("fs");
const file = require("path").join(process.env.HOME, ".claude.json");
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
const id = process.env.${APPROVAL_KEY_ENV}.slice(-${APPROVED_SUFFIX});
const r = cfg.customApiKeyResponses || {};
const approved = (r.approved || []).filter((k) => k !== id).concat(id);
const rejected = (r.rejected || []).filter((k) => k !== id);
cfg.customApiKeyResponses = Object.assign({}, r, { approved, rejected });
fs.writeFileSync(file, JSON.stringify(cfg), { mode: 0o600 });
'`;

/** `sbx exec` args that approve the key held in the client env var `APPROVAL_KEY_ENV`. */
export function approvalExecArgs(name: string): string[] {
  return ['exec', '--env', APPROVAL_KEY_ENV, name, '--', 'sh', '-c', APPROVAL_SCRIPT];
}

/** What the host gives one sandbox for a launch: its own key and the port of the proxy. */
export type OauthIssue =
  | { readonly ok: true; readonly key: string; readonly port: number; /** The proxy port of the key this one replaced (its policy rule is removed). */ readonly replacedPort?: number }
  | { readonly ok: false; readonly reason: string };

/** The host side of the proxy, per sandbox name. The runner never sees a token. */
export interface SbxOauthGrants {
  /** Issue a fresh key for the sandbox under the account, and revoke the previous one of the same sandbox. */
  issue(sandbox: string, account: string): Promise<OauthIssue>;
  /** Revoke the key of the sandbox and forget it; the proxy port of the revoked grant, when there was one. */
  release(sandbox: string): Promise<{ readonly port?: number }>;
}

/** An sbx launch through the proxy: `account` is set for a stored-token account, unset for any other (a stale grant is then released). */
export interface SbxOauthLaunch {
  readonly grants: SbxOauthGrants;
  readonly account?: string;
}

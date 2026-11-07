/**
 * Import a shell alias ONE time (@arch:AC-55). The alias text is PARSED, never
 * run or eval'd. Grammar: `[VAR=value ...] <binary> [args...]`; `$HOME`, `${HOME}`
 * and a leading `~` expand; quotes are stripped. Anything else (functions, pipes,
 * `;`, `&&`, `$(...)`, backticks, other variables) is refused with a reason.
 */
import { CORE_HOME_ENV, isSecretEnvKey, validateAccountName, type AccountCore, type SubscriptionAccount } from './types.js';

export type AliasImport =
  | { readonly ok: true; readonly account: SubscriptionAccount }
  | { readonly ok: false; readonly reason: string };

const FORBIDDEN_UNQUOTED = new Set([';', '&', '|', '<', '>', '`', '(', ')', '{', '}', '*', '?', '!', '#', '\n']);
const ENV_ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

function expandVar(text: string, i: number, home: string): { value: string; next: number } | string {
  // `text[i]` is `$`.
  const rest = text.slice(i + 1);
  if (rest.startsWith('(')) return 'command substitution $(...) is not supported';
  const m = /^\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(rest) ?? /^([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
  if (!m) return "a bare '$' is not supported";
  if (m[1] !== 'HOME') return `variable $${m[1]} is not supported (only $HOME)`;
  return { value: home, next: i + 1 + m[0].length };
}

function tokenize(input: string, home: string): string[] | string {
  const tokens: string[] = [];
  let cur = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; ) {
    const ch = input[i] as string;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '`') return 'backticks are not supported';
      else if (ch === '\\') return 'backslash escapes are not supported';
      else if (ch === '$') {
        const r = expandVar(input, i, home);
        if (typeof r === 'string') return r;
        cur += r.value;
        i = r.next;
        continue;
      } else cur += ch;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      i += 1;
      continue;
    }
    if (/\s/.test(ch) && ch !== '\n') {
      if (started || cur !== '') tokens.push(cur);
      cur = '';
      started = false;
      i += 1;
      continue;
    }
    if (FORBIDDEN_UNQUOTED.has(ch)) return `'${ch === '\n' ? '\\n' : ch}' is not supported (only a simple command is imported)`;
    if (ch === '\\') return 'backslash escapes are not supported';
    if (ch === '$') {
      const r = expandVar(input, i, home);
      if (typeof r === 'string') return r;
      cur += r.value;
      started = true;
      i = r.next;
      continue;
    }
    const next = input[i + 1];
    if (ch === '~' && (cur === '' || /^[A-Za-z_][A-Za-z0-9_]*=$/.test(cur)) && !quote && (next === undefined || next === '/' || /\s/.test(next))) {
      cur += home;
      started = true;
      i += 1;
      continue;
    }
    cur += ch;
    started = true;
    i += 1;
  }
  if (quote) return 'an unterminated quote';
  if (started || cur !== '') tokens.push(cur);
  return tokens;
}

/** The right-hand side of `alias name='...'` / `name='...'` output, or an error. */
function aliasBody(text: string, name: string): string | { error: string } {
  const line = text.trim();
  if (line === '') return { error: `no alias named '${name}' was found` };
  if (line.includes('\n')) return { error: 'expected one alias definition' };
  const m = /^(?:alias\s+)?([A-Za-z0-9._-]+)=(.*)$/s.exec(line);
  if (!m) return { error: `could not read an alias definition for '${name}'` };
  if (m[1] !== name) return { error: `the definition is for '${m[1]}', not '${name}'` };
  let body = (m[2] as string).trim();
  const first = body[0];
  if (body.length >= 2 && (first === "'" || first === '"') && body.endsWith(first)) body = body.slice(1, -1);
  return body;
}

const cannot = (reason: string): AliasImport => ({ ok: false, reason: `cannot import: ${reason}` });

export function parseShellAlias(input: {
  readonly core: AccountCore;
  readonly name: string;
  readonly aliasText: string;
  readonly home: string;
  /** The core's normal binary name (for example `claude`). */
  readonly defaultBinary: string;
}): AliasImport {
  const nameProblem = validateAccountName(input.name);
  if (nameProblem) return { ok: false, reason: nameProblem };
  const body = aliasBody(input.aliasText, input.name);
  if (typeof body !== 'string') return cannot(body.error);
  const tokens = tokenize(body, input.home);
  if (typeof tokens === 'string') return cannot(`${tokens}. Enter the command and folder manually.`);
  const env: Record<string, string> = {};
  let i = 0;
  for (; i < tokens.length; i += 1) {
    const m = ENV_ASSIGN.exec(tokens[i] as string);
    if (!m) break;
    if (isSecretEnvKey(m[1] as string)) {
      return cannot(`env key '${m[1]}' looks like a secret and karst does not store it. Sign in under the account folder instead.`);
    }
    env[m[1] as string] = m[2] as string;
  }
  const binary = tokens[i];
  if (!binary) return cannot('the alias has no command');
  if (input.core === 'opencode2') {
    return cannot('an opencode2 account uses a karst-owned folder. Create a managed account and set the command manually.');
  }
  const homeVar = CORE_HOME_ENV[input.core];
  const dir = env[homeVar];
  if (!dir) return cannot(`the alias does not set ${homeVar}, so karst cannot find the account folder. Enter the folder manually.`);
  if (!dir.startsWith('/')) return cannot(`${homeVar} is not an absolute path after expansion`);
  const args = tokens.slice(i + 1);
  const isDefaultBinary = binary === input.defaultBinary;
  return {
    ok: true,
    account: {
      kind: 'subscription',
      source: isDefaultBinary ? 'folder' : 'command',
      dir,
      ...(isDefaultBinary ? {} : { command: binary }),
      ...(args.length > 0 ? { args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    },
  };
}

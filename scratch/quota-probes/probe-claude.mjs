#!/usr/bin/env node
/**
 * Probe script for Claude Code statusline / usage data.
 *
 * Analysis of potential sources:
 * 1. Usage API: Anthropic does not expose a public OAuth usage API endpoint for individual Claude AI subscriptions.
 *    The OAuth token granted to Claude Code has scopes `user:file_upload`, `user:inference`, `user:mcp_servers`,
 *    `user:plugins`, `user:profile`, `user:sessions:claude_code`.
 * 2. Statusline hook: Claude Code delivers runtime stats including `rate_limits`
 *    (e.g., `{ five_hour: { used_percentage, resets_at }, seven_day: { used_percentage, resets_at } }`)
 *    via stdin JSON to custom statusLine commands configured in `~/.claude/settings.json`.
 *    A karst-managed statusline wrapper can cache this payload into a local JSON file whenever Claude runs.
 * 3. Fallback: Local keychain (`Claude Code-credentials`) records static `subscriptionType` (e.g. "pro")
 *    and `rateLimitTier` (e.g. "default_claude_ai"), but does not contain real-time window usage %.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function probeClaudeQuotaFromCache(cachePath = join(homedir(), '.claude', 'cache', 'quota.json')) {
  if (!existsSync(cachePath)) {
    return {
      status: 'no_cached_statusline_data',
      message: 'No statusline quota cache found. Claude Code sends rate_limits to statusLine stdin during active sessions.',
      supported_shape: {
        rate_limits: {
          five_hour: {
            used_percentage: 34,
            resets_at: 1746540000
          },
          seven_day: {
            used_percentage: 12,
            resets_at: 1746799200
          }
        }
      }
    };
  }

  try {
    return JSON.parse(readFileSync(cachePath, 'utf8'));
  } catch (err) {
    return { status: 'error', error: err.message };
  }
}

/** Replace every leaf with its type name: keys and types only, never a value (arch:AC-48). */
export function describeShape(value) {
  if (Array.isArray(value)) return value.length ? [describeShape(value[0])] : [];
  if (value === null) return 'null';
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, describeShape(v)]));
  }
  return typeof value;
}

/** GET /api/oauth/usage with a token from CLAUDE_OAUTH_TOKEN; returns the shape only. The token is never printed. */
export async function probeClaudeUsageShape(token = process.env.CLAUDE_OAUTH_TOKEN) {
  if (!token) return { status: 'no_token', message: 'Set CLAUDE_OAUTH_TOKEN to run this probe.' };
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
  });
  if (!res.ok) return { status: 'http_error', code: res.status };
  return { status: 'ok', shape: describeShape(await res.json()) };
}

if (process.argv[1]?.endsWith('probe-claude.mjs') && process.argv[2] === '--usage') {
  console.log(JSON.stringify(await probeClaudeUsageShape(), null, 2));
} else if (process.argv[1]?.endsWith('probe-claude.mjs')) {
  const res = probeClaudeQuotaFromCache();
  console.log('Claude Quota Probe:');
  console.log(JSON.stringify(res, null, 2));
}

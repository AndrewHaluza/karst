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

if (process.argv[1]?.endsWith('probe-claude.mjs')) {
  const res = probeClaudeQuotaFromCache();
  console.log('Claude Quota Probe:');
  console.log(JSON.stringify(res, null, 2));
}

#!/usr/bin/env node
/**
 * Probe script for OpenCode (v1 / v2).
 *
 * Findings:
 * 1. OpenCode stores authentication tokens in `~/.local/share/opencode/auth.json` (e.g. `opencode-go`, `openrouter`).
 * 2. Headless CLI status command `opencode stats --standalone --json` provides local cumulative token spend
 *    and costs per model, but does NOT report provider subscription window limits (used %, window length, reset time).
 * 3. OpenCode Go subscription quotas ($10/mo Go, $40/mo Go Plus with 5-hour $12 rolling window and weekly caps)
 *    are hosted on OpenCode Console. There is no official public usage API endpoint exposed via the API key
 *    (requests for GET /zen/go/v1/usage remain open feature requests upstream).
 * 4. Local SQLite database (`~/.local/share/opencode/opencode.db`) stores conversations and parts, not server rate limit states.
 *
 * Verdict: UNKNOWN / NONE
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function probeOpenCodeQuota() {
  const authPath = join(homedir(), '.local', 'share', 'opencode', 'auth.json');
  const hasAuth = existsSync(authPath);
  let providers = [];
  if (hasAuth) {
    try {
      providers = Object.keys(JSON.parse(readFileSync(authPath, 'utf8')));
    } catch {
      // Ignore
    }
  }

  return {
    core: 'opencode',
    verdict: 'unknown',
    hasAuth,
    configuredProviders: providers,
    authSource: hasAuth ? authPath : null,
    reason: 'OpenCode CLI does not record rolling subscription window rate limits in local DB or headless output, and OpenCode Go provides no public zero-spend usage API endpoint.',
    fieldsAvailable: []
  };
}

if (process.argv[1]?.endsWith('probe-opencode.mjs')) {
  console.log('OpenCode Quota Probe:');
  console.log(JSON.stringify(probeOpenCodeQuota(), null, 2));
}

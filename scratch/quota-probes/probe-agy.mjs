#!/usr/bin/env node
/**
 * Probe script for Antigravity (agy).
 *
 * SPIKE-QUOTA-FIND-A-ZERO-REQUEST (T822) re-probed all candidate sources in AC-29 preference order:
 *
 * 1. Provider usage API (reusing stored auth ~/.gemini/oauth_creds.json or antigravity-oauth-token):
 *    - CloudCode PA internal endpoints (`https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`)
 *      fail with 403 Forbidden / PERMISSION_DENIED (reason: SUBSCRIPTION_REQUIRED, domain: cloudaicompanion.googleapis.com)
 *      because consumer Antigravity accounts lack Google Cloud enterprise Gemini Code Assist licenses.
 *    - `v1internal:loadCodeAssist` succeeds (200 OK) but returns tier metadata (`allowedTiers`, `ineligibleTiers`)
 *      with zero quota windows, usage percentages, or reset stamps.
 *    - Google Cloud Quotas / Monitoring APIs require a user GCP project, which consumer accounts lack
 *      (agy defaults to virtual client ID `default-cli-project`).
 *
 * 2. Local data written by agy:
 *    - Conversation step metadata (`~/.gemini/antigravity-cli/conversations/` or `conversation_summaries.db`):
 *      Stores cumulative per-step token counts (`steps.metadata`), not subscription rate limit windows (rejected by AC-29/D162).
 *    - Language Server Connect endpoint (`POST /exa.language_server_pb.LanguageServerService/GetUserStatus`):
 *      Exposes per-model `quotaInfo.{remainingFraction,resetTime}` and plan credits during an active turn.
 *      However, it is NOT a persistent system daemon: it is spawned by `agy` per CLI session on an ephemeral,
 *      random loopback port with an in-memory random CSRF token (`ANTIGRAVITY_CSRF_TOKEN`). When agy is idle
 *      or before launch, no language server process or listening port exists.
 *      Furthermore, across the Docker backend boundary (ccf74c0a9ea, 72d0ae4bb51), the language server binds
 *      inside the container's isolated network namespace, unreachable by the host extension host's QuotaService.
 *
 * 3. Headless CLI status/usage output:
 *    - `agy` CLI provides subcommands (agent, models, mcp, plugin, update, remote-control) but NO headless `quota`
 *      or `status` subcommand. Interactive `/usage` is a TUI slash command only executed during live turns.
 *
 * 4. Verdict: UNKNOWN (NO-GO for reader).
 *    In accordance with AC-05, agy legitimately reports `unknown` (in `src/agent/quota/unsupported.ts`),
 *    never a fabricated 0%.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function probeAgyAuth() {
  const home = homedir();
  const oauthCredsPath = join(home, '.gemini', 'oauth_creds.json');
  const agyTokenPath = join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');

  const hasOauthCreds = existsSync(oauthCredsPath);
  const hasAgyToken = existsSync(agyTokenPath);

  let oauthScopes = null;
  if (hasOauthCreds) {
    try {
      const data = JSON.parse(readFileSync(oauthCredsPath, 'utf8'));
      oauthScopes = data.scope ?? null;
    } catch {
      // Ignore parse failure
    }
  }

  let authMethod = null;
  if (hasAgyToken) {
    try {
      const data = JSON.parse(readFileSync(agyTokenPath, 'utf8'));
      authMethod = data.auth_method ?? null;
    } catch {
      // Ignore parse failure
    }
  }

  return {
    hasAuth: hasOauthCreds || hasAgyToken,
    hasOauthCreds,
    hasAgyToken,
    oauthScopes,
    authMethod,
    sources: [
      hasAgyToken ? agyTokenPath : null,
      hasOauthCreds ? oauthCredsPath : null,
      'macOS Keychain (service: "gemini", account: "antigravity")'
    ].filter(Boolean)
  };
}

export function probeAgyLanguageServerEnv() {
  const address = process.env.ANTIGRAVITY_LS_ADDRESS ?? null;
  const hasCsrf = Boolean(process.env.ANTIGRAVITY_CSRF_TOKEN);

  return {
    activeInEnvironment: Boolean(address && hasCsrf),
    address,
    hasCsrfToken: hasCsrf,
    lifecycle: 'ephemeral child process spawned per active agy turn; dead when idle or before launch',
    dockerReachability: 'unreachable from host; language server runs in isolated container network namespace (ccf74c0a9ea, 72d0ae4bb51)'
  };
}

export function probeAgyQuota() {
  const auth = probeAgyAuth();
  const ls = probeAgyLanguageServerEnv();

  return {
    core: 'antigravity',
    verdict: 'unknown',
    reasons: [
      'Candidate 1 (Provider API): cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary returns 403 PERMISSION_DENIED (SUBSCRIPTION_REQUIRED) without enterprise license; v1internal:loadCodeAssist returns tier definitions without quota windows; Google Cloud Quotas requires customer GCP project absent in consumer accounts.',
      'Candidate 2 (Local data): SQLite steps.metadata only stores token counts (rejected by AC-29 as self-estimation); Language Server GetUserStatus provides quotaInfo only during active turns on ephemeral loopback ports with in-memory CSRF tokens, absent at idle/before launch, and network-isolated in Docker backend.',
      'Candidate 3 (Headless CLI): agy binary has no headless quota/status subcommand; /usage is an interactive slash command.',
      'Candidate 4 (Verdict): legitimate unknown verdict pursuant to arch:AC-05 and arch:AC-29.'
    ],
    candidates: {
      candidate1_provider_api: {
        tested: true,
        endpoint: 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
        status: '403 Forbidden (SUBSCRIPTION_REQUIRED - enterprise license required)',
        viable: false
      },
      candidate2_local_data: {
        conversation_step_tokens: { viable: false, reason: 'token usage only, no rate-limit window (AC-29/D162)' },
        language_server_get_user_status: {
          viable: false,
          reason: 'ephemeral per-turn process; dead when idle; random port + in-memory CSRF; container-isolated in Docker'
        }
      },
      candidate3_cli_subcommands: {
        viable: false,
        subcommandsChecked: ['models', 'agent', 'remote-control'],
        hasQuotaSubcommand: false
      }
    },
    auth,
    languageServer: ls
  };
}

if (process.argv[1]?.endsWith('probe-agy.mjs')) {
  console.log('Antigravity (agy) Quota Probe:');
  console.log(JSON.stringify(probeAgyQuota(), null, 2));
}

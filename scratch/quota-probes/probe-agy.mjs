#!/usr/bin/env node
/**
 * Probe script for Antigravity (agy).
 *
 * Findings:
 * 1. Antigravity stores OAuth credentials in `~/.gemini/oauth_creds.json`
 *    with scope `https://www.googleapis.com/auth/cloud-platform`.
 * 2. Antigravity stores conversation steps and token usage in local SQLite DBs (`steps.metadata`).
 * 3. Subscription quotas for Google Gemini / Antigravity (e.g. daily quota, requests per minute)
 *    are managed server-side via Google Cloud IAM/Quotas and Cloud Monitoring.
 *    There is no zero-request local rate-limit file or headless usage status command that exposes
 *    the active subscription-window remaining percentage.
 *
 * Verdict: UNKNOWN / NONE
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function probeAgyQuota() {
  const credsPath = join(homedir(), '.gemini', 'oauth_creds.json');
  const hasCreds = existsSync(credsPath);

  return {
    core: 'antigravity',
    verdict: 'unknown',
    hasAuth: hasCreds,
    authSource: hasCreds ? credsPath : null,
    reason: 'Google Cloud/Antigravity does not expose subscription window percentage via local JSON/DB or zero-spend CLI command.',
    fieldsAvailable: []
  };
}

if (process.argv[1]?.endsWith('probe-agy.mjs')) {
  console.log('Antigravity Quota Probe:');
  console.log(JSON.stringify(probeAgyQuota(), null, 2));
}

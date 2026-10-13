#!/usr/bin/env node
/**
 * Probe script for Codex session rate_limits.
 *
 * Source: Local CLI session JSONL files (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`).
 * Auth reused: None required (reads files written by Codex CLI under user's home dir).
 * Cost: Zero model requests, zero network calls.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function findLatestCodexSessionFile(baseDir = join(homedir(), '.codex', 'sessions')) {
  if (!existsSync(baseDir)) return null;

  let newestFile = null;
  let newestMtime = 0;

  function walk(dir, depth = 0) {
    if (depth > 4) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
          const st = statSync(full);
          if (st.mtimeMs > newestMtime) {
            newestMtime = st.mtimeMs;
            newestFile = full;
          }
        }
      }
    } catch {
      // Ignore unreadable dirs
    }
  }

  walk(baseDir);
  return newestFile;
}

export function probeCodexQuota(filePath) {
  const target = filePath ?? findLatestCodexSessionFile();
  if (!target || !existsSync(target)) return null;

  const content = readFileSync(target, 'utf8');
  const lines = content.trim().split('\n');

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line || !line.includes('rate_limits')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.payload?.rate_limits) {
        return {
          sessionFile: target,
          rate_limits: parsed.payload.rate_limits,
        };
      }
    } catch {
      // Ignore corrupt line
    }
  }
  return null;
}

if (process.argv[1]?.endsWith('probe-codex.mjs')) {
  const result = probeCodexQuota();
  if (result) {
    console.log('Codex Quota Probe: SUCCESS');
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('Codex Quota Probe: NO DATA FOUND');
  }
}

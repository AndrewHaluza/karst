/**
 * T0.1 — Subscription headless execution spike (throwaway).
 *
 * Goal: prove `claude -p` runs authenticated and returns structured JSON with a
 * session_id, drawing on the subscription (plan usage) rather than API credits.
 *
 * Auth: inherits the user's existing `claude` login (macOS Keychain). If
 * CLAUDE_CODE_OAUTH_TOKEN is present in env it is passed through, but it is NOT
 * required — the point is that the extension host can shell `claude -p` and have
 * it work with whatever auth the user already established.
 *
 * Run: npx tsx spikes/s0-headless.ts
 *
 * Done when: prints a parsed JSON result carrying a session_id, no API-key prompt,
 * and (manual eyeball) plan usage — not API credits — ticked up.
 */

import { spawn } from 'node:child_process';

const PROMPT = 'Reply with exactly the word: pong';

interface HeadlessResult {
  sessionId: string;
  result: string;
  raw: string;
}

/**
 * The exact invocation M4's headless stages will reuse. Kept in one place so the
 * production adapter (src/agent/adapter.ts) can copy it verbatim.
 */
function claudeHeadlessArgs(prompt: string): string[] {
  return ['-p', prompt, '--output-format', 'json'];
}

function runHeadless(prompt: string): Promise<HeadlessResult> {
  return new Promise((resolve, reject) => {
    const args = claudeHeadlessArgs(prompt);
    // Inherit the full env so Keychain-backed auth (or an optional
    // CLAUDE_CODE_OAUTH_TOKEN) is available to the child.
    const child = spawn('claude', args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('error', (err) =>
      reject(new Error(`failed to spawn claude: ${err.message}`)),
    );

    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `claude exited ${code}. stderr:\n${stderr || '(empty)'}\nstdout:\n${stdout || '(empty)'}`,
          ),
        );
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch (e) {
        reject(
          new Error(
            `output was not valid JSON: ${(e as Error).message}\nraw:\n${stdout}`,
          ),
        );
        return;
      }
      const obj = parsed as Record<string, unknown>;
      const sessionId = obj.session_id;
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        reject(
          new Error(
            `no session_id in result. keys: ${Object.keys(obj).join(', ')}`,
          ),
        );
        return;
      }
      resolve({
        sessionId,
        result: typeof obj.result === 'string' ? obj.result : '',
        raw: stdout,
      });
    });
  });
}

async function main(): Promise<void> {
  const hasToken = Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  console.log(
    `[s0-headless] auth: ${hasToken ? 'CLAUDE_CODE_OAUTH_TOKEN present' : 'inherited (Keychain/login)'}`,
  );
  console.log(`[s0-headless] invocation: claude ${claudeHeadlessArgs(PROMPT).join(' ')}`);

  const res = await runHeadless(PROMPT);

  console.log('\n[s0-headless] PASS');
  console.log(`  session_id: ${res.sessionId}`);
  console.log(`  result:     ${res.result.trim()}`);
  console.log(
    '\n[manual check] Confirm this run drew on PLAN usage (not API credits) — eyeball your plan usage.',
  );
}

main().catch((err) => {
  console.error('\n[s0-headless] FAIL');
  console.error(err.message);
  process.exit(1);
});

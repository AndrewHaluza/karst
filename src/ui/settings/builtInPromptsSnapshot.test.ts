import { describe, it, expect } from 'vitest';
import { buildBuiltInPrompts } from './builtInPrompts.js';
import type { Manifest } from '../../manifest/types.js';
import { PROMPT_BEARING_PROCESS_KEYS } from '../../manifest/validate/processAssignments.js';

/**
 * The Settings page shows host-built prompt text. No webview bundle imports the
 * builders, so a text change in `tester.ts` or a shared module would skip the
 * visual gate. These committed files sit under `src/ui/settings/`, so a text
 * change edits a UI path of the settings view (@arch:GATE-REPEAT).
 * Update them with `npx vitest run -u src/ui/settings/builtInPromptsSnapshot.test.ts`.
 */
const SNAPSHOT_DIR = './builtInPromptsSnapshots';
const manifestFor = (agentProvider: string): Manifest => ({ agentProvider }) as unknown as Manifest;

// One render per structured-output form, with the inputs `buildSettingsState` passes.
const CASES: ReadonlyArray<readonly [string, Manifest | undefined]> = [
  ['prose', undefined],
  ['tool', manifestFor('claude')],
  ['document', manifestFor('codex')],
];

describe('built-in prompt snapshots', () => {
  for (const [form, manifest] of CASES) {
    const prompts = buildBuiltInPrompts(manifest);
    for (const key of PROMPT_BEARING_PROCESS_KEYS) {
      it(`${key} (${form} output rule) matches its committed file`, async () => {
        const text = prompts[key];
        expect(text).not.toBeNull();
        await expect(text).toMatchFileSnapshot(`${SNAPSHOT_DIR}/${key}.${form}.txt`);
      });
    }
  }
});

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// The number ratchets down as extractions land and is, with the exception of
// the planned servers seed wiring below, never raised. The value is the
// measured line count plus 3 lines of deliberate slack. It was raised once for
// the ONBOARDING-SETUP-AGENT binding: the setup feature's activation call is a
// thin deps object in `activate()`, and its launch/proposal/watch logic lives in
// `src/extension/setupWiring.ts` + `src/extension/ops/setup*.ts`. Anything
// larger than a thin binding belongs in src/extension/ops/. Raised by 2 for the
// graph-ticket mailbox binding (one import + one `visitMailboxOf` line in the
// driver deps; the logic lives in `src/approaches/graph/visitMailbox*.ts`).
// Raised by 2 for the 'Karst: Run Doctor' binding (one import + one registration;
// logic is in `src/ui/doctor/host.ts` and `ops/doctorOps.ts`).
// Raised by 2 for the draft-constraints bindings (`archDocs` on the proposal ops,
// `repoPaths`/`commitExists`/`onWarnings` on the outbox); the checks live in
// `ops/planningConstraintChecks.ts`.
// Raised by 10 for the sub-task provider sync binding (`syncSubtask: makeSubtaskSync({...})`
// in the lifecycle deps + 2 imports; logic is in `ops/subtaskSyncOps.ts`).
const MAX_EXTENSION_LINES = 8441;

describe('extension.ts ratchet', () => {
  it('extension.ts does not exceed the recorded line count', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');
    const lineCount = source.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(MAX_EXTENSION_LINES);
  });
});

describe('ops/ has no vscode import', () => {
  it('no file under src/extension/ops/ imports vscode', () => {
    const opsDir = join(process.cwd(), 'src', 'extension', 'ops');
    const files = readdirSync(opsDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    const vscodeRe = /from ['"]vscode['"]|require\(['"]vscode['"]\)/;
    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(join(opsDir, file), 'utf8');
      if (vscodeRe.test(content)) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });
});

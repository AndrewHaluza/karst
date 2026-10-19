/**
 * A session id captured inside a sandbox exists only there: resuming it from the
 * host would either fail or, worse, continue a sandbox conversation outside its
 * enforcement boundary (arch:AC-31/AC-33). One shared guard for every host-side
 * resume path (interactive launch, headless fix/graph/autonomous runs).
 */
export class SandboxResumeOnHostError extends Error {
  constructor(readonly ticketId: number) {
    super(`ticket ${ticketId} has a sandbox: its session id exists only there, so it is not resumed on the host`);
    this.name = 'SandboxResumeOnHostError';
  }
}

export interface ResumeGuardInput {
  readonly ticketId: number;
  /** The session id about to be passed to `--resume` (absent = a fresh session, always allowed). */
  readonly resume: string | undefined;
  /** The runner that would execute the resume. */
  readonly runner: 'host' | 'sbx' | 'docker';
  /** The ticket has a sandbox (from the runners' listing). */
  readonly hasSandbox: boolean;
}

export function assertNoSandboxResumeOnHost(input: ResumeGuardInput): void {
  if (input.resume !== undefined && input.runner === 'host' && input.hasSandbox) {
    throw new SandboxResumeOnHostError(input.ticketId);
  }
}

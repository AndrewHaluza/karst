/**
 * Establish the optional Development-preview palette context before registering
 * its command. This is deliberately host-agnostic: VS Code context writes can
 * reject, but that cosmetic failure must be logged without aborting activation.
 */
export async function setPreviewContextThenContinue(opts: {
  setContext: () => PromiseLike<unknown>;
  logError: (message: string, error: unknown) => void;
  continueActivation: () => void;
}): Promise<void> {
  try {
    await opts.setContext();
  } catch (error) {
    opts.logError('inside preview context setup failed', error);
  }
  opts.continueActivation();
}

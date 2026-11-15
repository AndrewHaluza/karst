/**
 * The host's drain flag (@arch:DRAIN-01). While it is set, no new stage, gate or
 * headless-agent run starts; runs already live finish. It lives in memory only:
 * a window reload clears it by design.
 */
export interface Drain {
  isDraining(): boolean;
  begin(): void;
  cancel(): void;
}

export function createDrain(): Drain {
  let draining = false;
  return {
    isDraining: () => draining,
    begin: () => {
      draining = true;
    },
    cancel: () => {
      draining = false;
    },
  };
}

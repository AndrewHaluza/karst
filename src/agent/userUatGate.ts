/**
 * arch:AC-32 decision 7: while the agent UAT runs on a ticket's services, the
 * user UAT link (open / copy URL) is withheld, so the two never overlap on the
 * one shared instance. In-memory: a host restart mid-UAT re-runs the stage.
 */
export interface UserUatGate {
  withhold(ticketId: number): void;
  release(ticketId: number): void;
  isWithheld(ticketId: number): boolean;
}

export function createUserUatGate(): UserUatGate {
  const held = new Set<number>();
  return {
    withhold: (id) => { held.add(id); },
    release: (id) => { held.delete(id); },
    isWithheld: (id) => held.has(id),
  };
}

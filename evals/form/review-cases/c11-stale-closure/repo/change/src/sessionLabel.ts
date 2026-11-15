export interface Session {
  user: string;
  retries: number;
}

/** Returns a function that reports the current state of the session. */
export function createLabel(session: Session): () => string {
  const { user, retries } = session;
  return () => `${user}: ${retries} retries`;
}

export function recordRetry(session: Session): void {
  session.retries += 1;
}

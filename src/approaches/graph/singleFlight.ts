/**
 * A per-key single-flight guard for the graph continuation.
 *
 * Two triggers of one graph run (a coordinator tick and a planner tab close,
 * or a recovery and a sweep tick) start a drive a few hundred ms apart. Run in
 * parallel, they race on the same workspace. This guard keeps one drive per
 * key in flight. A call made while a drive runs does not start a second one:
 * it asks for ONE re-run after the current drive, and returns the same promise.
 *
 * Host-agnostic: no vscode, no store.
 */

interface Flight {
  promise: Promise<void>;
  rerun: boolean;
}

export function perKeySingleFlight<K>(run: (key: K) => Promise<void>): (key: K) => Promise<void> {
  const flights = new Map<K, Flight>();
  return (key: K): Promise<void> => {
    const current = flights.get(key);
    if (current) {
      current.rerun = true;
      return current.promise;
    }
    const flight: Flight = { rerun: false, promise: Promise.resolve() };
    flight.promise = (async () => {
      try {
        do {
          flight.rerun = false;
          await run(key);
        } while (flight.rerun);
      } finally {
        flights.delete(key);
      }
    })();
    flights.set(key, flight);
    return flight.promise;
  };
}

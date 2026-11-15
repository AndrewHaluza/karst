export async function retry<T>(fn: () => Promise<T>, maxAttempts: number): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= maxAttempts + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

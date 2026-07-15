/**
 * Render a health-check URL template into a concrete URL. The template
 * convention is `{host}` + `{port}` (documented in `manifest/types.ts`, the
 * Settings UI hint, and `resolver/resolve.ts`), e.g. `http://{host}:{port}/health`.
 *
 * `{http}` is accepted as an alias for the http port so any legacy template that
 * used it keeps resolving. This is the SINGLE renderer shared by the baseline
 * (`baseline.ts`) and per-ticket (`spin.ts`) start paths — previously each had a
 * private copy that substituted only `{http}`, so a `{port}` template was never
 * filled in and the health check hung against a malformed URL.
 */
export function renderHealthUrl(template: string, host: string, port: number): string {
  return template
    .replaceAll('{host}', host)
    .replaceAll('{port}', String(port))
    .replaceAll('{http}', String(port));
}

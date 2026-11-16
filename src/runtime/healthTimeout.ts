import type { ServiceDef } from '../manifest/types.js';

/**
 * The health-gate budget a service declared (`healthTimeoutSeconds`), in ms, or
 * undefined when it declared none — the caller then passes no timeout, and
 * `waitForHealth` applies its 30-second default. The ONE conversion: the ticket
 * start, the sandboxed start and the baseline start all use it.
 */
export function healthTimeoutMsOf(service: Pick<ServiceDef, 'healthTimeoutSeconds'>): number | undefined {
  return service.healthTimeoutSeconds === undefined ? undefined : service.healthTimeoutSeconds * 1000;
}

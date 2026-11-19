/**
 * The ports the WHATWG Fetch standard blocks. Node's `fetch` (undici) throws
 * `bad port` and Chrome shows `ERR_UNSAFE_PORT` for each of them, so a service
 * on one of these can never pass an HTTP health check, be opened by the UAT
 * browser, or be framed by the dashboard, even when the service is healthy.
 *
 * The list is copied, not imported from undici internals (not a public API).
 * It was verified by a real `fetch` on ports 1-11000 (Node 22.22): 82 ports.
 */
const BLOCKED_PORT_LIST: readonly number[] = [
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
];

const BLOCKED_PORTS: ReadonlySet<number> = new Set(BLOCKED_PORT_LIST);

/** True when `fetch` and Chrome refuse to connect to `port`. */
export function isBlockedPort(port: number): boolean {
  return BLOCKED_PORTS.has(port);
}

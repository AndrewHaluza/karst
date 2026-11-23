/**
 * One byte formatter for every Doctor check (DR-8). Binary units (1024) so the
 * WAL limit, Docker VM memory and sandbox disk read the same way.
 */
export function formatDoctorBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

import type { Manifest } from '../manifest/types.js';
import { makeDryRunAllocator } from '../resolver/allocator.js';
import { resolve } from '../resolver/resolve.js';

/**
 * Preview the resolved env for a hypothetical hot set (§7.4) — the misconfig
 * catcher. Runs the resolver with a dry-run (non-persisting) allocator and dumps
 * each service's mode, ports, env, and baseline deps. No servers, no DB writes.
 */
export function previewEnv(manifest: Manifest, hot: string[]): string {
  // Dry-run preview: no real ticket, and the dry-run allocator ignores the id.
  const result = resolve(manifest, hot, makeDryRunAllocator(manifest.portRange), 0);

  const lines: string[] = [`Resolved env preview — hot: ${hot.join(', ') || '(none)'}`];

  for (const [name, svc] of Object.entries(result.services)) {
    lines.push('', `${name}  [${svc.mode}]`);

    const portStr = Object.entries(svc.ports)
      .map(([slot, port]) => `${slot}=${port}`)
      .join(', ');
    lines.push(`  ports: ${portStr || '(none)'}`);

    const envEntries = Object.entries(svc.env);
    if (envEntries.length === 0) {
      lines.push('  env:   (none)');
    } else {
      envEntries.forEach(([k, v], i) => {
        const label = i === 0 ? '  env:   ' : '         ';
        lines.push(`${label}${k}=${v}`);
      });
    }

    if (svc.baselineDeps.length > 0) {
      lines.push(`  baseline deps: ${svc.baselineDeps.join(', ')}`);
    }
  }

  lines.push('', `start order: ${result.startOrder.join(', ') || '(none)'}`);

  return lines.join('\n') + '\n';
}

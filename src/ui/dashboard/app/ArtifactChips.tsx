/**
 * The status word, stale flag and origin chip of an artifact card. Same DOM as the vanilla helpers
 * (`artifactStatusHtml`, `artifactStaleHtml`, `originChip`), which the still-vanilla index and detail
 * views keep using until the full-screen artifact view migrates.
 */
import { memo } from 'react';
import { AGENT_PROVIDER_LABELS } from '../../../model/agentProviders.js';
import { AgentIcon } from './AgentIcon.js';

const STATUS_WORD: Record<string, string> = { passed: 'Passed', failed: 'Failed', attention: 'Needs attention', info: 'In progress' };
const STATUS_CLASS = new Set(['passed', 'failed', 'attention', 'info']);

export function StatusChip({ status }: { readonly status: string }) {
  return <span className={`art-status ${STATUS_CLASS.has(status) ? status : 'info'}`}>{STATUS_WORD[status] ?? status}</span>;
}

export function StaleChip({ stale }: { readonly stale: boolean }) {
  return stale ? (
    <span className="art-stale" title="No longer validates the current implementation">
      Stale
    </span>
  ) : null;
}

// The current monochrome karst mark (media/karst-mark.svg), inlined because the webview CSP forbids external assets.
function KarstMark() {
  return (
    <svg className="kmark" viewBox="0 0 215 215" aria-hidden="true" focusable="false">
      <path d="M 96 20 L 25 67 L 25 156 L 98 203 L 98 180 L 44 145 L 44 78 L 97 44 Z" fill="currentColor" />
      <path d="M 151 42 L 138 58 L 170 78 L 170 144 L 138 165 L 150 180 L 188 156 L 188 67 Z" fill="currentColor" />
      <circle cx="106.5" cy="111.5" r="26.5" fill="currentColor" />
    </svg>
  );
}

export interface Origin {
  readonly kind: string;
  readonly core: string | null;
}

/** The mark is a secondary carrier; the label is the identity (UI-R28). */
export const OriginChip = memo(function OriginChip({ origin }: { readonly origin: Origin | null | undefined }) {
  const o = origin ?? { kind: 'karst', core: null };
  const core = o.core ?? '';
  const coreLabel = (core && (AGENT_PROVIDER_LABELS as Record<string, string>)[core]) || core;
  if (o.kind === 'native') {
    return (
      <span className="art-origin" aria-label={`${coreLabel} native artifact`}>
        <AgentIcon provider={core} />
        <span>{coreLabel} · Native</span>
      </span>
    );
  }
  return (
    <span className="art-origin" aria-label={o.core ? `karst artifact for ${coreLabel}` : 'karst artifact'}>
      <KarstMark />
      <span>{o.core ? `Karst · ${coreLabel}` : 'Karst'}</span>
    </span>
  );
});

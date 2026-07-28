import type { Ticket } from '../store/tickets.js'
import type { FinalizedDiagnosticReport } from './types.js'

export const DISCLOSURE = Object.freeze({
  included:
    'Included now — diagnostic metadata: runtime, report-local correlation references, '
    + 'stages, gates, phases, effective configuration and bounded sanitized Karst logs.',
  notIncluded:
    'Not included — session context: ticket description, brief and other prompt-like text.',
  alwaysExcluded:
    'Always excluded: secrets, credentials, tokens, private keys, authenticated URLs, '
    + 'environment values, credential-store data, transcripts, raw dumps and unrelated data.',
})

export const CONTEXT_ACTIONS = Object.freeze([
  'Continue without context',
  'Include context for this report',
  'Back',
] as const)

export interface TicketCandidate {
  readonly id: number
  readonly label: string
  readonly description: string
}

type CandidateTicket = Pick<Ticket, 'id' | 'projectId' | 'key' | 'title' | 'stageCurrent'> & {
  readonly updatedAt?: string | null
}

export function ticketCandidates(
  tickets: readonly CandidateTicket[],
  projectId: number,
  requestedId?: number,
): TicketCandidate[] {
  const owned = tickets.filter((ticket) => ticket.projectId === projectId)
  if (requestedId !== undefined && !owned.some((ticket) => ticket.id === requestedId)) {
    throw new Error('scoped_not_found')
  }
  return owned.map((ticket) => ({
    id: ticket.id,
    label: `${ticket.key ?? `#${ticket.id}`} — ${ticket.title ?? '(untitled)'}`,
    description: [
      `Stage: ${ticket.stageCurrent ?? 'not started'}`,
      ...(ticket.updatedAt ? [`Updated: ${ticket.updatedAt}`] : []),
    ].join(' · '),
  }))
}

export function buildReviewSummary(snapshot: FinalizedDiagnosticReport): string {
  const context = snapshot.report.contextStatus === 'approved'
    ? 'Metadata and approved session context'
    : 'Metadata only'
  const notices = Object.entries(snapshot.report.metadata)
    .flatMap(([name, section]) => {
      if (section?.status === 'truncated') {
        return [`${name}: truncated (${section.omitted} omitted by ${section.reason})`]
      }
      return section?.status === 'unavailable'
        ? [`${name}: unavailable (${section.reason})`]
        : []
    })
  const redactions = Object.entries(snapshot.report.redactions)
    .map(([category, count]) => `${category}: ${count}`)
  return [
    context,
    'This is a point-in-time snapshot and may contain only the latest session reference.',
    `Checksum: ${snapshot.checksum}`,
    ...(notices.length ? ['Section notices:', ...notices] : []),
    ...(redactions.length ? ['Redactions:', ...redactions] : ['Redactions: none']),
  ].join('\n')
}

const GITHUB_ISSUES = 'https://github.com/AndrewHaluza/karst/issues/new'

export function buildGitHubIssueUrl(
  snapshot: FinalizedDiagnosticReport,
  extensionVersion: string,
): string {
  const url = new URL(GITHUB_ISSUES)
  url.searchParams.set('title', '[Karst] ')
  url.searchParams.set('body', [
    'Describe what happened and what you expected.',
    '',
    `Karst version: ${extensionVersion}`,
    `Report schema: v${snapshot.report.reportVersion}`,
    `Report reference: ${snapshot.report.reportId}`,
    `Checksum: ${snapshot.checksum}`,
    '',
    'Karst did not upload diagnostics. After reviewing this form, paste or attach the '
      + 'diagnostic report and submit the issue in GitHub.',
  ].join('\n'))
  return url.toString()
}

/**
 * Mint the read-only preview path for one render.
 *
 * Every render gets its own path, deliberately: `remove-context` re-finalizes
 * under the SAME `reportId`, and a `TextDocumentContentProvider` is only asked
 * for content when a URI is opened the first time. Keying the URI by report id
 * alone would leave the user reviewing the previously opened bytes while the
 * exported snapshot had already changed — the one thing the reviewed artifact
 * must never do.
 */
export function makeDocumentPaths(): (kind: 'metadata' | 'final', id: string) => string {
  let revision = 0
  return (kind, id) => {
    revision += 1
    return `/${kind}/${encodeURIComponent(id)}-${revision}.md`
  }
}

/**
 * Suggested local filename for Save. Deliberately uses the real ticket key
 * rather than the report alias: this names a file on the reporter's own disk in
 * a dialog they confirm, and a pseudonymous name would make their own reports
 * unfindable. The key never enters the report bytes, which stay pseudonymized.
 */
export function reportFileName(ticketLabel: string | undefined, generatedAt: string): string {
  const ticketPart = ticketLabel
    ?.replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  const timestamp = `${generatedAt.slice(0, 10)}T${generatedAt.slice(11, 19).replace(/:/g, '')}Z`
  return `karst-issue-${ticketPart ? `${ticketPart}-` : ''}${timestamp}.md`
}

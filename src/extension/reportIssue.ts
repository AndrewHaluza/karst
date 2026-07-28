import { randomUUID } from 'node:crypto'
import * as vscode from 'vscode'
import type { LogBuffer } from '../logging/logger.js'
import type { Manifest } from '../manifest/types.js'
import type { Store } from '../store/db.js'
import type { Project } from '../store/projects.js'
import { listTickets } from '../store/tickets.js'
import { collectApprovedContext } from '../diagnostics/context.js'
import {
  CollectionCancelledError,
  collectMetadata,
  collectProjectMetadata,
} from '../diagnostics/collectMetadata.js'
import { finalizeReport } from '../diagnostics/finalize.js'
import { createPseudonymizer } from '../diagnostics/pseudonymize.js'
import {
  CONTEXT_ACTIONS,
  DISCLOSURE,
  buildGitHubIssueUrl,
  buildReviewSummary,
  makeDocumentPaths,
  reportFileName,
  ticketCandidates,
} from '../diagnostics/reportIssueModel.js'
import {
  runReportFlow,
  type FinalReviewAction,
  type MetadataPreviewAction,
  type ReportFlowPorts,
} from '../diagnostics/reportFlow.js'
import type { DiagnosticDraft, FinalizedDiagnosticReport } from '../diagnostics/types.js'

const SCHEME = 'karst-diagnostic'

export class DiagnosticDocumentProvider implements vscode.TextDocumentContentProvider {
  private readonly documents = new Map<string, string>()
  private readonly pathFor = makeDocumentPaths()

  put(kind: 'metadata' | 'final', id: string, content: string): vscode.Uri {
    const uri = vscode.Uri.parse(`${SCHEME}:${this.pathFor(kind, id)}`)
    this.documents.set(uri.toString(), content)
    return uri
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.documents.get(uri.toString()) ?? 'Diagnostic preview is no longer available.'
  }

  clear(): void {
    this.documents.clear()
  }
}

export interface ReportIssueDependencies {
  readonly context: vscode.ExtensionContext
  readonly store: Store
  readonly logs: LogBuffer
  readonly documents: DiagnosticDocumentProvider
  readonly currentProject: () => Project | undefined
  readonly currentManifest: () => Manifest | undefined
}

function ticketIdArg(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id?: unknown }).id
    if (typeof id === 'number' && Number.isInteger(id)) return id
  }
  return undefined
}

async function reveal(documents: DiagnosticDocumentProvider, uri: vscode.Uri): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri)
  await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false })
}

function metadataPreview(draft: DiagnosticDraft): string {
  const snapshot = finalizeReport({ ...draft, contextStatus: 'declined' })
  return [
    '# Review before sharing',
    '',
    'This report currently contains diagnostic metadata only.',
    '',
    `- ${DISCLOSURE.included}`,
    `- ${DISCLOSURE.notIncluded}`,
    `- ${DISCLOSURE.alwaysExcluded}`,
    '',
    '---',
    '',
    snapshot.markdown,
  ].join('\n')
}

async function chooseFinalAction(
  snapshot: FinalizedDiagnosticReport,
): Promise<FinalReviewAction> {
  const actions = [
    'Copy report',
    'Save report…',
    'Open GitHub issue',
    ...(snapshot.report.contextStatus === 'approved' ? ['Remove context'] : []),
    'Refresh snapshot',
    'Cancel',
  ]
  const choice = await vscode.window.showInformationMessage(
    `${buildReviewSummary(snapshot)}\n\nCopy and Save use exactly the snapshot shown. `
      + 'Karst does not upload it automatically.',
    { modal: true },
    ...actions,
  )
  if (choice === 'Copy report') return 'copy'
  if (choice === 'Save report…') return 'save'
  if (choice === 'Open GitHub issue') return 'handoff'
  if (choice === 'Remove context') return 'remove-context'
  if (choice === 'Refresh snapshot') return 'refresh'
  return 'cancel'
}

function makePorts(
  deps: ReportIssueDependencies,
  project: Project,
  manifest: Manifest,
  requestedId: number | undefined,
): ReportFlowPorts<number | 'project'> {
  let selectedLabel: string | undefined
  let selectedScope: number | 'project' | undefined
  return {
    select: async () => {
      const scopedTickets = listTickets(
        deps.store,
        { projectId: project.id, includeArchived: true },
      )
      let candidates
      try {
        candidates = ticketCandidates(
          scopedTickets,
          project.id,
          requestedId,
        )
      } catch {
        void vscode.window.showWarningMessage(
          'That ticket is not available in the current project. Choose another ticket.',
        )
        candidates = ticketCandidates(
          scopedTickets,
          project.id,
        )
      }
      if (requestedId !== undefined) {
        const selected = candidates.find((candidate) => candidate.id === requestedId)
        if (selected) {
          selectedLabel = selected.label.split(' — ')[0]
          selectedScope = selected.id
          return selectedScope
        }
      }
      if (candidates.length === 0) {
        void vscode.window.showInformationMessage(
          'Karst: no tickets found; preparing an extension-level report.',
        )
        selectedScope = 'project'
        return selectedScope
      }
      const picked = await vscode.window.showQuickPick([
        ...candidates,
        {
          id: 'project' as const,
          label: 'Karst extension / no specific ticket',
          description: 'Extension-level metadata and sanitized logs',
        },
      ], {
        placeHolder: 'What was affected?',
        matchOnDescription: true,
      })
      selectedLabel = picked?.label.split(' — ')[0]
      selectedScope = picked?.id
      return selectedScope
    },
    collectMetadata: async (selection) => {
      const generatedAt = new Date().toISOString()
      return vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Preparing a privacy-filtered diagnostic report…',
          cancellable: true,
        },
        async (_progress, token) => {
          if (token.isCancellationRequested) throw new CollectionCancelledError()
          const common = {
            isCancelled: () => token.isCancellationRequested,
            store: deps.store,
            project,
            manifest,
            logs: deps.logs,
            reportId: randomUUID(),
            generatedAt,
            aliases: createPseudonymizer(),
            runtime: {
              extensionVersion: String(deps.context.extension.packageJSON.version ?? 'unknown'),
              editorVersion: vscode.version,
              platform: process.platform,
              arch: process.arch,
              remoteNamePresent: vscode.env.remoteName !== undefined,
              uiKind: vscode.env.uiKind === vscode.UIKind.Web ? 'web' : 'desktop',
              developmentMode: deps.context.extensionMode === vscode.ExtensionMode.Development,
            },
          }
          const draft = selection === 'project'
            ? await collectProjectMetadata(common)
            : await collectMetadata({ ...common, ticketId: selection })
          if (token.isCancellationRequested) throw new CollectionCancelledError()
          return draft
        },
      )
    },
    previewMetadata: async (draft): Promise<MetadataPreviewAction> => {
      await reveal(deps.documents, deps.documents.put('metadata', draft.reportId, metadataPreview(draft)))
      const choice = await vscode.window.showInformationMessage(
        'Review before sharing. Continue does not approve session context.',
        { modal: true },
        'Continue',
        'Refresh snapshot',
        'Cancel',
      )
      return choice === 'Continue'
        ? 'continue'
        : choice === 'Refresh snapshot' ? 'refresh' : 'cancel'
    },
    decideContext: async () => {
      if (selectedScope === 'project') return 'decline'
      const choice = await vscode.window.showInformationMessage(
        'Include session context in this report?\n\n'
          + 'Approval adds only the ticket title, description, and brief. It may contain '
          + 'business details or other text you entered. Secrets remain excluded. '
          + 'Approval applies only to this report and is not remembered.',
        { modal: true },
        ...CONTEXT_ACTIONS,
      )
      if (choice === 'Include context for this report') return 'approve'
      if (choice === 'Continue without context') return 'decline'
      return 'back'
    },
    collectContext: async (selection) => {
      if (selection === 'project') throw new Error('context_not_applicable')
      return collectApprovedContext({
      store: deps.store,
      projectId: project.id,
      ticketId: selection,
      })
    },
    reviewFinal: async (snapshot) => {
      await reveal(deps.documents, deps.documents.put('final', snapshot.report.reportId, snapshot.markdown))
      return chooseFinalAction(snapshot)
    },
    copy: async (snapshot) => {
      await vscode.env.clipboard.writeText(snapshot.exportMarkdown())
      void vscode.window.showInformationMessage(
        'Report copied to clipboard. Nothing was uploaded.',
      )
    },
    save: async (snapshot) => {
      const suggestedName = reportFileName(selectedLabel, snapshot.report.generatedAt)
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
      const uri = await vscode.window.showSaveDialog({
        defaultUri: workspaceFolder
          ? vscode.Uri.joinPath(workspaceFolder.uri, suggestedName)
          : vscode.Uri.file(suggestedName),
        filters: { Markdown: ['md'] },
        saveLabel: 'Save report',
      })
      if (!uri) return 'cancelled'
      await vscode.workspace.fs.writeFile(uri, Buffer.from(snapshot.exportMarkdown(), 'utf8'))
      void vscode.window.showInformationMessage('Report saved. Nothing was uploaded.')
    },
    handoff: async (snapshot) => {
      const choice = await vscode.window.showInformationMessage(
        'GitHub will open with a short issue template. Diagnostics are not uploaded. '
          + 'Copy or save the reviewed report, then paste or attach it and submit in GitHub.',
        { modal: true },
        'Open GitHub issue',
        'Cancel',
      )
      if (choice !== 'Open GitHub issue') return 'cancelled'
      const version = String(deps.context.extension.packageJSON.version ?? 'unknown')
      const opened = await vscode.env.openExternal(
        vscode.Uri.parse(buildGitHubIssueUrl(snapshot, version)),
      )
      if (!opened) throw new Error('browser_open_failed')
      void vscode.window.showInformationMessage(
        'GitHub opened — finish and submit the issue in your browser. Nothing was uploaded.',
      )
    },
    onExportError: async () => {
      const choice = await vscode.window.showErrorMessage(
        'Could not export the report (export_failed). The reviewed snapshot is still available.',
        'Try again',
        'Cancel',
      )
      return choice === 'Try again' ? 'retry' : 'cancel'
    },
  }
}

export function createReportIssueHandler(
  deps: ReportIssueDependencies,
): (argument?: unknown) => Promise<void> {
  return async (argument?: unknown) => {
    const project = deps.currentProject()
    const manifest = deps.currentManifest()
    if (!project || !manifest) {
      void vscode.window.showWarningMessage(
        'Karst: open a configured project before creating an issue report.',
      )
      return
    }
    try {
      for (;;) {
        try {
          const result = await runReportFlow(makePorts(
            deps,
            project,
            manifest,
            ticketIdArg(argument),
          ))
          if (result.status === 'cancelled') {
            void vscode.window.showInformationMessage(
              'Issue report cancelled. Nothing was submitted.',
            )
          }
          return
        } catch (error) {
          if (error instanceof CollectionCancelledError) {
            void vscode.window.showInformationMessage(
              'Issue report cancelled. Nothing was submitted.',
            )
            return
          }
          const choice = await vscode.window.showErrorMessage(
            'Could not prepare the issue report (collection_failed). Nothing was submitted.',
            'Try again',
            'Cancel',
          )
          if (choice !== 'Try again') return
        }
      }
    } finally {
      deps.documents.clear()
    }
  }
}

export function registerDiagnosticDocumentProvider(
  provider: DiagnosticDocumentProvider,
): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider)
}

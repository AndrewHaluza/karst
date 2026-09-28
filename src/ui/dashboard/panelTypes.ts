import type { AgentProcessId, DashboardActions, StageLogResult } from './messages.js';
import type { GateStage } from '../../store/ticketGates.js';

/**
 * The subset of a `vscode.WebviewPanel` the manager touches. Modeling it as an
 * interface keeps `DashboardManager` host-agnostic and unit-testable without a
 * `vscode` module; the activation adapter supplies a real panel.
 */
export interface DashboardPanel {
  /**
   * Bring the panel forward. `preserveFocus` leaves the keyboard where it is
   * (real: `panel.reveal(column, preserveFocus)`) — what the terminal binding
   * needs, and what keeps a bound reveal from re-activating the panel and
   * bouncing the focus straight back.
   */
  reveal(preserveFocus?: boolean): void;
  postMessage(message: unknown): void;
  onDidReceiveMessage(handler: (message: unknown) => void): void;
  /**
   * The panel gained or lost activation (real: `onDidChangeViewState`, reading
   * `e.webviewPanel.active`). `active` is true only when the user is actually
   * on this panel — a preserve-focus reveal makes it visible, not active.
   */
  onDidChangeViewState(handler: (active: boolean) => void): void;
  onDidDispose(handler: () => void): void;
  /**
   * Whether the panel's webview is on screen at all (real: `panel.visible`) —
   * unlike `active`, which is true only when the user is ON it. A dashboard
   * watched beside a terminal the user is typing in is VISIBLE and inactive,
   * which is the live tick's main scenario, so visibility is what gates the
   * repaint. Absent → assume visible, which is exactly the pre-tick behavior.
   */
  isVisible?(): boolean;
  /** Update the tab icon (real: `panel.iconPath = Uri.file(path)`). */
  setIcon(path: string): void;
}

/** Factory the manager uses to mint panels (real: `createWebviewPanel`). */
export interface PanelHost {
  createPanel(title: string, ticketId: number, preserveFocus?: boolean): DashboardPanel;
}

/** Test double surface — extends the panel with recorded state + an emitter. */
export interface FakePanel extends DashboardPanel {
  title: string;
  revealed: number;
  /** The `preserveFocus` the panel was CREATED with, if any. */
  createdPreserveFocus?: boolean;
  /** The `preserveFocus` argument of every `reveal`, in order. */
  revealedPreserveFocus: Array<boolean | undefined>;
  disposed: boolean;
  /** Whether the fake reports itself on screen — drives `isVisible`. */
  visible: boolean;
  posted: unknown[];
  /** Every `setIcon` path, in order — the live-tint assertion surface. */
  icons: string[];
  messageHandlers: Array<(m: unknown) => void>;
  viewStateHandlers: Array<(active: boolean) => void>;
  disposeHandler?: () => void;
  dispose(): void;
  emit(message: unknown): void;
  emitViewState(active: boolean): void;
}

/**
 * The window's terminal↔dashboard binding, injected so the manager needs no
 * knowledge of the binder itself. `enabled` is read live (it flips at runtime);
 * `onDidActivate` reports raw panel activation — including LOSING it — and
 * leaves the interpretation to the binder.
 */
export interface DashboardBinding {
  enabled(): boolean;
  onDidActivate(ticketId: number, active: boolean): void;
}

/** Resolve the daemon actions for a ticket (lets the host bind live services). */
export type ActionsFactory = (ticketId: number) => DashboardActions;

/** Resolve one gate stage's console log host-side (store + fs). */
export type StageLogReader = (ticketId: number, stage: GateStage) => StageLogResult;

/** Resolve one gate-lane AI process's console tail host-side (fs). */
export type AgentLogReader = (ticketId: number, processId: AgentProcessId) => StageLogResult;

/**
 * List the base-branch candidates for a worktree's repoPath, pre-bound by the
 * host to `listBaseBranchCandidates` (Task 4) with the git runner it needs.
 * Never throws (the underlying lister already swallows git failures to `[]`).
 */
export type BranchCandidatesLoader = (repoPath: string) => Promise<string[]>;

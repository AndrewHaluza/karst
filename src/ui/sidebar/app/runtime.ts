/**
 * Typed access to the shared design-system runtime the sidebar document injects
 * (`/*KARST_DS_JS*\/`, `/*KARST_AGENT_JS*\/`). These are classic-script function
 * declarations, so they live on the global object; the app reads them lazily
 * (never at import time) so the module graph loads without a page.
 *
 * Nothing here re-implements the runtime: request ids, pending/settle, toasts,
 * the Tabler catalog and the agent identity markup all stay owned by it.
 */
interface DsRuntime {
  karstRequestId(): string;
  karstIsPending(el: Element): boolean;
  karstBeginPending(el: Element, requestId: string, tier?: string): void;
  karstSettle(requestId: string, ok: boolean | null, message?: string): void;
  karstToast(kind: 'success' | 'error' | 'warning', message: string): void;
  karstIcon(name: string, size?: number, cls?: string): string;
  agentLabel(provider: string): string;
  agentIdentityHtml(provider: string, model: string | null, compact: boolean): string;
}

const rt = (): DsRuntime => globalThis as unknown as DsRuntime;

export const ds = {
  requestId: () => rt().karstRequestId(),
  isPending: (el: Element) => rt().karstIsPending(el),
  beginPending: (el: Element, requestId: string) => rt().karstBeginPending(el, requestId),
  settle: (requestId: string, ok: boolean | null, message?: string) => rt().karstSettle(requestId, ok, message),
  toast: (kind: 'success' | 'error' | 'warning', message: string) => rt().karstToast(kind, message),
  icon: (name: string, size?: number, cls?: string) => rt().karstIcon(name, size, cls),
  agentLabel: (provider: string) => rt().agentLabel(provider),
  agentIdentityHtml: (provider: string, model: string | null, compact: boolean) =>
    rt().agentIdentityHtml(provider, model, compact),
};

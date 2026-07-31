/** What VS Code paints on the activity-bar container icon. */
export interface BadgeValue {
  value: number;
  tooltip: string;
}

/** The `WebviewView.badge` setter, narrowed so this module never sees `vscode`. */
export interface BadgeTarget {
  setBadge(badge: BadgeValue | undefined): void;
}

/**
 * Keeps the badge alive across view resolves.
 *
 * A `WebviewView` only exists once VS Code has resolved it, and in a cold window
 * the user may never have opened the Tickets view — which is EXACTLY the case
 * the badge exists for. So the value is held here and replayed on every attach.
 *
 * A count of zero clears the badge. Assigning `{ value: 0 }` renders a `0`
 * bubble on the logo, which reads as a state rather than the absence of one.
 */
export class BadgeCache {
  private current: BadgeValue | undefined;
  private target: BadgeTarget | undefined;

  set(value: number, tooltip: string): void {
    this.current = value > 0 ? { value, tooltip } : undefined;
    this.target?.setBadge(this.current);
  }

  clear(): void {
    this.current = undefined;
    this.target?.setBadge(undefined);
  }

  /** Bind the live view and replay whatever the badge should currently be. */
  attach(target: BadgeTarget): void {
    this.target = target;
    target.setBadge(this.current);
  }
}

/**
 * A loader warning with a stable code. The code names WHAT is wrong, from the
 * place that makes the warning (for example `manifest.legacy-services`), so it
 * does not move when another warning goes away. The message stays a string for
 * display.
 */
export interface CodedWarning {
  code: string;
  message: string;
}

export function warningMessages(warnings: readonly CodedWarning[]): string[] {
  return warnings.map((w) => w.message);
}

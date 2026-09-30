/**
 * The ported settings sections (NDL-126 §8 phase 3).
 *
 * Phase 1 lands the container with no sections yet: the vanilla script is still
 * the live implementation, so rendering nothing is correct — the parity gate in
 * phase 4 is what decides when a section may move across.
 *
 * Section order mirrors the tabs in `src/ui/settings/webview.html`.
 */
export function AppSections() {
  return (
    <div data-karst-settings-app="true">
      {/* Sections are ported one at a time in phase 3; see NDL-126 §8. */}
    </div>
  );
}

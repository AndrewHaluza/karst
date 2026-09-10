/**
 * Fixed VS Code theme variable blocks for the visual sweep.
 *
 * These are a TRANSCRIPTION of VS Code's built-in Dark Modern, Light Modern,
 * and Dark High Contrast themes.  A VS Code theme change does NOT automatically
 * invalidate a baseline — the baseline pins karst's rendering against a FIXED
 * theme, which is the point.
 *
 * This file is the ONLY place a theme value may be edited.  The `--vscode-*`
 * variables are those karst actually reads (grep -rho '--vscode-[a-zA-Z0-9-]*'
 * src | sort -u, minus two truncated prefixes).
 *
 * Font stacks are pinned identically across all three themes for determinism
 * (D8): --vscode-font-family, --vscode-font-size, --vscode-editor-font-family
 * override theme fidelity to prevent cross-run pixel drift.
 */

export const THEME_IDS = ['dark', 'light', 'hc'] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export interface Theme {
  readonly bodyClass: string;
  readonly rootCss: string;
}

const DARK_BODY = 'vscode-dark vscode-theme-defaults-themes-dark_modern-json';
const LIGHT_BODY = 'vscode-light vscode-theme-defaults-themes-light_modern-json';
const HC_BODY = 'vscode-high-contrast vscode-theme-defaults-themes-hc_black-json';

/** Deterministic font stack shared across all themes. */
const FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const FONT_SIZE = '13px';
const EDITOR_FONT_FAMILY = '"SF Mono", Menlo, monospace';

function rootBlock(vars: Record<string, string>): string {
  const props = Object.entries(vars)
    .map(([k, v]) => `${k}:${v}`)
    .join(';');
  return `:root{${props}}`;
}

const DARK_VARS: Record<string, string> = {
  '--vscode-badge-background': '#0e639c',
  '--vscode-badge-foreground': '#ffffff',
  '--vscode-button-background': '#0e639c',
  '--vscode-button-foreground': '#ffffff',
  '--vscode-button-hoverBackground': '#1177bb',
  '--vscode-button-secondaryBackground': '#3a3d41',
  '--vscode-button-secondaryForeground': '#ffffff',
  '--vscode-button-secondaryHoverBackground': '#45494e',
  '--vscode-charts-blue': '#3794ff',
  '--vscode-charts-green': '#4bb64b',
  '--vscode-charts-lines': '#6e7681',
  '--vscode-charts-purple': '#b180d7',
  '--vscode-charts-red': '#f14c4c',
  '--vscode-charts-yellow': '#cca700',
  '--vscode-contrastBorder': '#6fc3df',
  '--vscode-descriptionForeground': '#8b949e',
  '--vscode-disabledForeground': '#8b949e',
  '--vscode-dropdown-background': '#252526',
  '--vscode-dropdown-border': '#45494e',
  '--vscode-editor-background': '#1e1e1e',
  '--vscode-editor-font-family': EDITOR_FONT_FAMILY,
  '--vscode-editorWidget-background': '#252526',
  '--vscode-focusBorder': '#007fd4',
  '--vscode-font-family': FONT_FAMILY,
  '--vscode-font-size': FONT_SIZE,
  '--vscode-font-weight': 'normal',
  '--vscode-foreground': '#cccccc',
  '--vscode-input-background': '#3c3c3c',
  '--vscode-input-border': '#3c3c3c',
  '--vscode-input-foreground': '#cccccc',
  '--vscode-inputOption-activeBorder': '#007fd4',
  '--vscode-inputValidation-errorBackground': '#5a1d1d',
  '--vscode-inputValidation-errorBorder': '#f14c4c',
  '--vscode-list-activeSelectionBackground': '#094771',
  '--vscode-list-activeSelectionForeground': '#ffffff',
  '--vscode-list-hoverBackground': '#2a2d2e',
  '--vscode-list-inactiveSelectionBackground': '#37373d',
  '--vscode-panel-border': '#474747',
  '--vscode-sideBar-background': '#252526',
  '--vscode-testing-iconPassed': '#4bb64b',
  '--vscode-textLink-activeForeground': '#3794ff',
  '--vscode-textLink-foreground': '#3794ff',
};

const LIGHT_VARS: Record<string, string> = {
  '--vscode-badge-background': '#007acc',
  '--vscode-badge-foreground': '#ffffff',
  '--vscode-button-background': '#007acc',
  '--vscode-button-foreground': '#ffffff',
  '--vscode-button-hoverBackground': '#0062a3',
  '--vscode-button-secondaryBackground': '#5f6a79',
  '--vscode-button-secondaryForeground': '#ffffff',
  '--vscode-button-secondaryHoverBackground': '#4c525e',
  '--vscode-charts-blue': '#0062a3',
  '--vscode-charts-green': '#16825d',
  '--vscode-charts-lines': '#bfbdad',
  '--vscode-charts-purple': '#652d90',
  '--vscode-charts-red': '#e51400',
  '--vscode-charts-yellow': '#bf8803',
  '--vscode-contrastBorder': '#000000',
  '--vscode-descriptionForeground': '#616161',
  '--vscode-disabledForeground': '#a0a0a0',
  '--vscode-dropdown-background': '#ffffff',
  '--vscode-dropdown-border': '#cecece',
  '--vscode-editor-background': '#ffffff',
  '--vscode-editor-font-family': EDITOR_FONT_FAMILY,
  '--vscode-editorWidget-background': '#f3f3f3',
  '--vscode-focusBorder': '#0090f1',
  '--vscode-font-family': FONT_FAMILY,
  '--vscode-font-size': FONT_SIZE,
  '--vscode-font-weight': 'normal',
  '--vscode-foreground': '#616161',
  '--vscode-input-background': '#f3f3f3',
  '--vscode-input-border': '#cecece',
  '--vscode-input-foreground': '#616161',
  '--vscode-inputOption-activeBorder': '#0090f1',
  '--vscode-inputValidation-errorBackground': '#f2dede',
  '--vscode-inputValidation-errorBorder': '#e51400',
  '--vscode-list-activeSelectionBackground': '#0060c0',
  '--vscode-list-activeSelectionForeground': '#ffffff',
  '--vscode-list-hoverBackground': '#e8e8e8',
  '--vscode-list-inactiveSelectionBackground': '#d6ebff',
  '--vscode-panel-border': '#e7e7e7',
  '--vscode-sideBar-background': '#f3f3f3',
  '--vscode-testing-iconPassed': '#16825d',
  '--vscode-textLink-activeForeground': '#006ab1',
  '--vscode-textLink-foreground': '#006ab1',
};

const HC_VARS: Record<string, string> = {
  '--vscode-badge-background': '#000000',
  '--vscode-badge-foreground': '#ffffff',
  '--vscode-button-background': '#000000',
  '--vscode-button-foreground': '#ffffff',
  '--vscode-button-hoverBackground': '#1b1b1b',
  '--vscode-button-secondaryBackground': '#1b1b1b',
  '--vscode-button-secondaryForeground': '#ffffff',
  '--vscode-button-secondaryHoverBackground': '#3a3a3a',
  '--vscode-charts-blue': '#3794ff',
  '--vscode-charts-green': '#4bb64b',
  '--vscode-charts-lines': '#6e7681',
  '--vscode-charts-purple': '#b180d7',
  '--vscode-charts-red': '#f14c4c',
  '--vscode-charts-yellow': '#cca700',
  '--vscode-contrastBorder': '#6fc3df',
  '--vscode-descriptionForeground': '#ffffff',
  '--vscode-disabledForeground': '#ffffff',
  '--vscode-dropdown-background': '#000000',
  '--vscode-dropdown-border': '#6fc3df',
  '--vscode-editor-background': '#000000',
  '--vscode-editor-font-family': EDITOR_FONT_FAMILY,
  '--vscode-editorWidget-background': '#000000',
  '--vscode-focusBorder': '#6fc3df',
  '--vscode-font-family': FONT_FAMILY,
  '--vscode-font-size': FONT_SIZE,
  '--vscode-font-weight': 'normal',
  '--vscode-foreground': '#ffffff',
  '--vscode-input-background': '#000000',
  '--vscode-input-border': '#6fc3df',
  '--vscode-input-foreground': '#ffffff',
  '--vscode-inputOption-activeBorder': '#6fc3df',
  '--vscode-inputValidation-errorBackground': '#5a1d1d',
  '--vscode-inputValidation-errorBorder': '#f14c4c',
  '--vscode-list-activeSelectionBackground': '#003868',
  '--vscode-list-activeSelectionForeground': '#ffffff',
  '--vscode-list-hoverBackground': '#0a3250',
  '--vscode-list-inactiveSelectionBackground': '#003868',
  '--vscode-panel-border': '#6fc3df',
  '--vscode-sideBar-background': '#000000',
  '--vscode-testing-iconPassed': '#4bb64b',
  '--vscode-textLink-activeForeground': '#3794ff',
  '--vscode-textLink-foreground': '#3794ff',
};

export const THEMES: Readonly<Record<ThemeId, Theme>> = {
  dark: { bodyClass: DARK_BODY, rootCss: rootBlock(DARK_VARS) },
  light: { bodyClass: LIGHT_BODY, rootCss: rootBlock(LIGHT_VARS) },
  hc: { bodyClass: HC_BODY, rootCss: rootBlock(HC_VARS) },
};

/** The 42 --vscode-* variables that must be defined in every theme. */
export const REQUIRED_VARS: readonly string[] = Object.keys(DARK_VARS).sort();

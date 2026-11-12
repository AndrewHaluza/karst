// ESLint exists for ONE reason (NDL-126 §1, R-X4): to enforce the React hooks
// contract on the settings React app. It is scoped to `src/ui/settings/app/**`
// and must not grow into a repo-wide linter by accident — the rest of the
// codebase is guarded by `tsc`, the UI conformance tests and review. A second
// reason: regex backtracking in webview code that parses provider text (ReDoS).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import regexp from 'eslint-plugin-regexp';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'src/ui/settings/app.webview.js', 'src/ui/dashboard/app.webview.js', 'src/ui/resources/app.webview.js', 'src/ui/sidebar/app.webview.js'],
  },
  {
    files: ['src/ui/settings/app/**/*.{ts,tsx}', 'src/ui/dashboard/app/**/*.{ts,tsx}', 'src/ui/resources/app/**/*.{ts,tsx}', 'src/ui/sidebar/app/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    plugins: { 'react-hooks': reactHooks, regexp },
    rules: {
      // R-X4: derived values are computed in render or `useMemo`; effects only
      // sync with the outside world. `exhaustive-deps` is the mechanical half.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      // ReDoS guard: provider text reaches these regexes. Only the two
      // super-linear rules are on, not the plugin's style-heavy recommended set.
      'regexp/no-super-linear-backtracking': 'error',
      'regexp/no-super-linear-move': 'error',
    },
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  {
    // Tests run these regexes on this repo's own source files, never on provider
    // text; input is bounded by file size, so the ReDoS rules do not apply.
    files: ['src/ui/{settings,dashboard,resources,sidebar}/app/**/*.test.{ts,tsx}'],
    rules: {
      'regexp/no-super-linear-backtracking': 'off',
      'regexp/no-super-linear-move': 'off',
    },
  },
);
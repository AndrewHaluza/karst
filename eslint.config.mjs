// ESLint exists for ONE reason (NDL-126 §1, R-X4): to enforce the React hooks
// contract on the settings React app. It is scoped to `src/ui/settings/app/**`
// and must not grow into a repo-wide linter by accident — the rest of the
// codebase is guarded by `tsc`, the UI conformance tests and review.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'src/ui/settings/app.webview.js'],
  },
  {
    files: ['src/ui/settings/app/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // R-X4: derived values are computed in render or `useMemo`; effects only
      // sync with the outside world. `exhaustive-deps` is the mechanical half.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
);
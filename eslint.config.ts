import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      // Preserve the original rule's intent (ignore intentionally-unused PascalCase/UPPER
      // vars). Also ignore throwaway function args (the codebase uses params like `_path`
      // and unused event objects) and unused catch bindings — all pre-existing patterns.
      '@typescript-eslint/no-unused-vars': ['error', {
        args: 'none',
        varsIgnorePattern: '^[A-Z_]',
        caughtErrors: 'none',
      }],
      // New in react-hooks v7. The app intentionally calls setState inside effects
      // (rebuild the link-graph; restore the last-opened file on mount). Refactoring
      // would change behavior we are explicitly preserving.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    // The FileSystem context module intentionally exports its Provider together with the
    // useFileSystem hook (a standard React pattern). Don't let the fast-refresh rule
    // force a structural split of an unchanged file.
    files: ['src/context/**/*.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
])

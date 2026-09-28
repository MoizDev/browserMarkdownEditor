import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'helper/dist']),
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
      // Every tooltip is the app's own bubble (utils/tooltip.ts, keyed on
      // `data-tooltip`); a stray native `title` would draw Chromium's OS box beside
      // it, late and unthemed. Intrinsic elements only (lowercase name): a
      // component's `title` prop (ConfirmDialog's) is data, and an SVG `<title>` is a
      // child, not an attribute. `document.title` is the tab title, not a tooltip.
      'no-restricted-syntax': ['error',
        {
          selector: 'JSXOpeningElement[name.name=/^[a-z]/] > JSXAttribute[name.name="title"]',
          message: 'Use data-tooltip (utils/tooltip.ts draws the app\'s own tooltip) — never the native title attribute.',
        },
        {
          selector: 'AssignmentExpression[left.type="MemberExpression"][left.property.name="title"]:not([left.object.name="document"])',
          message: 'Set dataset.tooltip (utils/tooltip.ts), not .title.',
        },
        {
          selector: 'AssignmentExpression[left.type="MemberExpression"][left.computed=true][left.property.value="title"]',
          message: 'Set dataset.tooltip (utils/tooltip.ts), not [\'title\'].',
        },
        {
          selector: 'CallExpression[callee.property.name="setAttribute"][arguments.0.value="title"]',
          message: 'Use data-tooltip, not the title attribute.',
        },
        {
          selector: 'CallExpression[callee.property.name="setAttribute"][arguments.0.type="TemplateLiteral"][arguments.0.quasis.0.value.raw="title"]',
          message: 'Use data-tooltip, not the title attribute.',
        },
        {
          selector: 'CallExpression[callee.property.name="setAttributeNS"][arguments.1.value="title"]',
          message: 'Use data-tooltip, not the title attribute.',
        },
      ],
    },
  },
  {
    // The VaultAgent helper is a Bun program, not browser code; `shared/` is
    // imported by both sides, so it may assume neither's globals beyond these.
    files: ['helper/**/*.ts', 'shared/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node, Bun: 'readonly' },
    },
    rules: {
      'react-refresh/only-export-components': 'off',
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

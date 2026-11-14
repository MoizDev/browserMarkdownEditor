import js from '@eslint/js'
import { readFileSync } from 'node:fs'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'
import { bmePlugin } from './eslint.rules.ts'

// ONE native map feeds the backend, linker and lint. Refuse a damaged map
// rather than quietly widening the prebuilt development engine's surface.
const pdfiumMap = JSON.parse(readFileSync(new URL('./src/pdf/engine/pdfium/exports.json', import.meta.url), 'utf8')) as {
  rows: { exports: string[] }[];
}
const pdfiumNativeExports = pdfiumMap.rows.flatMap(row => row.exports)
if (pdfiumNativeExports.length !== 138 || new Set(pdfiumNativeExports).size !== 138) throw new Error('The canonical PDFium map must declare 138 unique native exports')

// The tooltip rule's selectors (explained where the rule is set, below). Named, because
// a later block that sets no-restricted-syntax replaces the whole option array and must
// repeat them, never silently drop them.
const tooltipRestrictions = [
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
]

export default defineConfig([
  // `planning/` is git-ignored and exists only in the main checkout: its evidence
  // scripts are records of the planning run, not code of this repository.
  globalIgnores(['dist', 'helper/dist', 'planning']),
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
      'no-restricted-syntax': ['error', ...tooltipRestrictions],
    },
  },
  {
    // D7 R7: the old optional-break regex backtracked exponentially. PDF find and
    // its anchors keep the bounded automaton, never a regular expression.
    files: ['src/utils/pdfFind.ts', 'src/utils/pdfTextAnchors.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...tooltipRestrictions,
        { selector: 'Literal[regex]', message: 'PDF find/anchors use the bounded matcher, never a regular expression (D7 R7).' },
        { selector: 'NewExpression[callee.name="RegExp"]', message: 'PDF find/anchors use the bounded matcher, never RegExp (D7 R7).' },
        { selector: 'CallExpression[callee.name="RegExp"]', message: 'PDF find/anchors use the bounded matcher, never RegExp (D7 R7).' },
      ],
    },
  },
  {
    // A raw localStorage write bypasses the IndexedDB recovery mirror, so another
    // window's origin reset could erase it. Tab-only sessionStorage also goes through
    // storage.ts, but stays out of that mirror: terminal IDs must not cross tabs.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/utils/storage.ts'],
    rules: {
      'no-restricted-properties': ['error',
        ...['localStorage', 'sessionStorage'].flatMap(object =>
          ['setItem', 'removeItem', 'clear'].map(property => ({
            object, property, message: 'Use utils/storage.ts for browser storage mutations',
          }))),
      ],
    },
  },
  {
    // P-02a: one value caller of pdf.js's getDocument (eslint.rules.ts says why).
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/utils/pdfClassicOpen.ts'],
    plugins: { bme: bmePlugin },
    rules: { 'bme/classic-pdf-open': 'error' },
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
    // foliate-js, byte-pinned to upstream (its sha256 is in source-lock.json), so
    // its own eslint-disable comments cannot be edited — and with no rules run on
    // .js here, every one of them reports as an unused directive.
    files: ['src/epub/vendor/**/*.js'],
    linterOptions: { reportUnusedDisableDirectives: 'off' },
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
  {
    // Browser-run scripts and the run toolbox (verify-in-browser): plain Node
    // modules whose init-script and page.evaluate closures run in the page, so
    // both sets of globals are real here.
    files: ['verify/**/*.{js,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    // The repo's own rules (eslint.rules.ts). Each was added with the error it
    // gives on a deliberately violating line, recorded in its commit.
    files: ['**/*.{ts,tsx,js,mjs,cjs,jsx}'],
    ignores: ['src/epub/vendor/**'],
    plugins: { bme: bmePlugin },
    rules: {
      // G-INV-04. The owner's ban on code-based tests, everywhere.
      'bme/no-tests': 'error',
    },
  },
  {
    files: ['src/pdf/**/*.{ts,tsx}'],
    rules: { 'bme/pdfium-boundaries': ['error', pdfiumNativeExports] },
  },
  {
    files: ['src/**/*.{ts,tsx}', 'shared/**/*.ts'],
    plugins: { bme: bmePlugin },
    rules: {
      // G-INV-06's engine zones (contracts C6.3) and I-0's dark zone: the new
      // engines import no React and no app layer, the whiteboard nothing of
      // tldraw's (independence protocol), and nothing outside the three engine
      // folders imports them until the package that wires a switch adds its
      // importer to `darkExcept` here.
      'bme/import-zones': ['error', [
        {
          files: ['src/platform/render', 'src/whiteboard', 'src/pdf'],
          dark: true,
          // PdfTiledView is itself a lazy switch target; its engine imports must
          // stay behind that boundary rather than moving into PdfPane/App.
          // These hooks are reached only through the lazy PdfTiledView chunk.
          darkExcept: ['src/platform/render', 'src/whiteboard', 'src/pdf', 'src/components/PdfTiledView.tsx', 'src/components/usePdfTextMirror.ts', 'src/components/usePdfTiledFind.tsx', 'src/components/usePdfTiledSelection.ts', 'src/components/usePdfTiledCopyMenu.ts', 'src/components/usePdfTiledTextReader.ts', 'src/components/PdfTiledTextSurface.tsx', 'src/components/PdfTiledTextSurface.types.ts'],
          // Switch-wiring files: the platform preview (bme.pdf.platformLayer, P-PL) and the generic
          // platform pane hook. Dynamic or type-only imports only, so the chunk stays lazy.
          darkLazy: ['src/utils/recoveryCopy.ts', 'src/components/usePdfPlatformPreview.ts', 'src/components/platformPane/usePlatformPane.ts', 'src/components/PdfViewer.tsx', 'src/components/PdfTiledSurface.tsx', 'src/components/PdfTiledTextSurface.types.ts'],
          message: 'The new engines stay dark until their switch is wired',
        },
        {
          files: ['src/platform', 'src/whiteboard', 'src/pdf'],
          noLocal: ['src/context', 'src/editor', 'src/components', 'src/App.tsx', 'src/main.tsx'],
          noPackage: ['react', 'react-dom'],
          message: 'Engines are React-free and reach the app through plain callbacks (contracts C6.3)',
        },
        {
          files: ['src/platform'],
          noLocal: ['src/utils', 'src/types', 'src/whiteboard', 'src/pdf', 'src/epub'],
          message: 'src/platform imports nothing app-specific (contracts C6.3)',
        },
        {
          files: ['src/whiteboard', 'src/pdf', 'src/platform'],
          noPackage: ['tldraw', '@tldraw', 'perfect-freehand'],
          message: 'No tldraw material in the new engines (independence protocol)',
        },
      ]],
      // G-INV-22. Baseline (contracts R1-18): the two note-text sinks AGENTS.md
      // names, the constant icon strings of three editor widgets, and the EPUB
      // shared contained-frame srcdoc. Core turns the icon sinks into DOM builders; then they go.
      'bme/html-sinks': ['error', [
        { file: 'src/editor/tableWidget.ts', names: ['innerHTML'], rhs: 'any' },
        { file: 'src/editor/mermaidWidget.ts', names: ['innerHTML'], rhs: 'any' },
        { file: 'src/editor/headingFold.ts', names: ['innerHTML'], rhs: 'constant' },
        { file: 'src/editor/imageWidget.ts', names: ['innerHTML'], rhs: 'constant' },
        { file: 'src/editor/copyCodeWidget.ts', names: ['innerHTML'], rhs: 'constant' },
        { file: 'src/platform/containedFrame.ts', names: ['srcdoc'], rhs: 'constant', identifiers: ['frameHTML'] },
      ]],
      // G-INV-FS: all File System Access calls stay in src/context/.
      'bme/fs-access': ['error', []],
    },
  },
])

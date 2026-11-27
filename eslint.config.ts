import js from '@eslint/js'
import { readFileSync } from 'node:fs'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'
import { bmePlugin } from './eslint.rules.ts'

const pdfiumMap = JSON.parse(readFileSync(new URL('./src/pdf/engine/pdfium/exports.json', import.meta.url), 'utf8')) as {
  rows: { exports: string[] }[];
}
const pdfiumNativeExports = pdfiumMap.rows.flatMap(row => row.exports)
if (pdfiumNativeExports.length !== 139 || new Set(pdfiumNativeExports).size !== 139) throw new Error('The canonical PDFium map must declare 139 unique native exports')

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

const workerAdvice = 'Start workers through workerScript (platform/workers/script.ts) with a `?worker&url` import, never new Worker().'
const workerRestrictions = [
  { selector: 'NewExpression[callee.property.name=/^(Shared)?Worker$/]', message: workerAdvice },
]
const workerGlobals = [{ name: 'Worker', message: workerAdvice }, { name: 'SharedWorker', message: workerAdvice }]

export default defineConfig([
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
      '@typescript-eslint/no-unused-vars': ['error', {
        args: 'none',
        varsIgnorePattern: '^[A-Z_]',
        caughtErrors: 'none',
      }],
      'react-hooks/set-state-in-effect': 'off',
      'no-restricted-syntax': ['error', ...tooltipRestrictions],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/platform/workers/script.ts', 'src/pdf/contained/brokerRuntime.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...tooltipRestrictions, ...workerRestrictions],
      'no-restricted-globals': ['error', ...workerGlobals],
    },
  },
  {
    files: ['src/utils/pdfFind.ts', 'src/utils/pdfTextAnchors.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...tooltipRestrictions, ...workerRestrictions,
        { selector: 'Literal[regex]', message: 'PDF find/anchors use the bounded matcher, never a regular expression (D7 R7).' },
        { selector: 'NewExpression[callee.name="RegExp"]', message: 'PDF find/anchors use the bounded matcher, never RegExp (D7 R7).' },
        { selector: 'CallExpression[callee.name="RegExp"]', message: 'PDF find/anchors use the bounded matcher, never RegExp (D7 R7).' },
      ],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/utils/storage.ts'],
    rules: {
      'no-restricted-properties': ['error',
        ...['localStorage', 'sessionStorage'].flatMap(object =>
          ['setItem', 'removeItem', 'clear'].map(property => ({
            object, property, message: 'Use utils/storage.ts for browser storage mutations',
          }))),
        { object: 'scheduler', property: 'yield', message: 'Yield with platform/yieldToHost.ts, the one feature-tested host yield' },
      ],
    },
  },
  {
    files: ['helper/**/*.ts', 'shared/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node, Bun: 'readonly' },
    },
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    files: ['src/epub/vendor/**/*.js'],
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  {
    files: ['src/context/**/*.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    files: ['verify/**/*.{js,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs,jsx}'],
    ignores: ['src/epub/vendor/**'],
    plugins: { bme: bmePlugin },
    rules: {
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
      'bme/import-zones': ['error', [
        {
          files: ['src/platform/render', 'src/whiteboard', 'src/pdf'],
          dark: true,
          darkExcept: ['src/platform/render', 'src/whiteboard', 'src/pdf', 'src/components/PdfPane.tsx', 'src/components/PdfTiledView.tsx', 'src/components/usePdfTextMirror.ts', 'src/components/usePdfTiledFind.tsx', 'src/components/usePdfTiledSelection.ts', 'src/components/usePdfTiledCopyMenu.ts', 'src/components/usePdfTiledTextReader.ts', 'src/components/usePdfTiledOutline.tsx', 'src/components/PdfTiledTextSurface.tsx', 'src/components/PdfTiledTextSurface.types.ts', 'src/components/whiteboard/NativeCanvasEntry.tsx', 'src/components/whiteboard/NativePdfEntry.tsx', 'src/components/whiteboard/nativeViewLease.ts', 'src/components/whiteboard/nativeClipboardController.ts', 'src/components/whiteboard/useNativeClipboard.ts', 'src/utils/nativeCanvasAgentRead.ts', 'src/utils/nativeCanvasAgentMutation.ts', 'src/utils/closedCanvasSource.ts',
            'src/components/whiteboard/NativeCanvasEditing.tsx', 'src/components/whiteboard/NativeBoardChrome.tsx', 'src/components/whiteboard/NativeBoardChromeHost.tsx',
            'src/components/whiteboard/nativeBoardActions.ts', 'src/components/whiteboard/nativeBoardContextMenu.ts', 'src/components/whiteboard/nativeBoardOperations.ts', 'src/components/whiteboard/nativeCameraOperations.ts',
            'src/components/whiteboard/nativeCommandSource.ts', 'src/components/whiteboard/nativeEditingKeyboard.ts', 'src/components/whiteboard/nativeEditingLease.ts',
            'src/components/whiteboard/nativeEditingCapabilityFactory.ts',
            'src/components/whiteboard/NativePictureCrop.tsx', 'src/components/whiteboard/pictureCropStore.ts', 'src/components/whiteboard/nativePdfEditingLease.ts',
            'src/components/whiteboard/preparePdfInkAttempt.ts',
            'src/components/whiteboard/nativeImportAdapter.ts', 'src/components/whiteboard/nativeLinkOperations.ts', 'src/components/whiteboard/nativeTextClipboard.ts',
            'src/components/whiteboard/useNativeBoardLanguage.ts', 'src/components/whiteboard/useNativeSheetControls.tsx',
            'src/components/whiteboard/chrome/StylePanel.tsx', 'src/components/whiteboard/chrome/styleIcons.tsx'],
          darkLazy: ['src/app/useAgentCanvasAccess.ts', 'src/app/agentCanvas.ts', 'src/app/pdfGestures.ts', 'src/app/diskBarActions.tsx', 'src/app/useCreateEntries.tsx', 'src/utils/agentHost.ts', 'src/utils/recoveryCopy.ts', 'src/components/usePdfPlatformPreview.ts', 'src/components/platformPane/usePlatformPane.ts', 'src/components/PdfViewer.tsx', 'src/components/PdfTiledSurface.tsx', 'src/components/pdfSurfaceModules.ts', 'src/components/PdfTiledTextSurface.types.ts', 'src/components/whiteboard/ViewerHost.tsx', 'src/components/whiteboard/nativeViewPlatform.ts'],
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
      'bme/html-sinks': ['error', [
        { file: 'src/editor/tableWidget.ts', names: ['innerHTML'], rhs: 'any' },
        { file: 'src/editor/mermaidWidget.ts', names: ['innerHTML'], rhs: 'any' },
        { file: 'src/editor/headingFold.ts', names: ['innerHTML'], rhs: 'constant' },
        { file: 'src/editor/imageWidget.ts', names: ['innerHTML'], rhs: 'constant' },
        { file: 'src/editor/copyCodeWidget.ts', names: ['innerHTML'], rhs: 'constant' },
        { file: 'src/platform/containedFrame.ts', names: ['srcdoc'], rhs: 'constant', identifiers: ['frameHTML'] },
      ]],
      'bme/fs-access': ['error', []],
    },
  },
])

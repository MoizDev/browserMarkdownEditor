// The repository's own lint rules: the static half of the invariants in
// `AGENTS.md` that no stock rule can state. Each rule's error on a deliberately
// violating line was recorded when it was added (the commit that added it says
// which line), so a rule that silently matches nothing is caught at that point.
//
// They are plain ESLint rules over the syntax tree: the repo's lint has no type
// information (eslint.config.ts), so they judge by names and paths, never types.
import path from 'node:path'
import type { Rule } from 'eslint'

const ROOT = path.dirname(new URL(import.meta.url).pathname)
const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join('/')

type Node = Rule.Node & Record<string, unknown>

/** The source of every static import, re-export, dynamic import() and require(). */
function onImport(context: Rule.RuleContext, report: (node: Rule.Node, source: string) => void): Rule.RuleListener {
  const check = (node: Rule.Node, src: unknown) => { if (typeof src === 'string') report(node, src) }
  return {
    ImportDeclaration: (n) => check(n, n.source.value),
    ExportAllDeclaration: (n) => check(n, n.source.value),
    ExportNamedDeclaration: (n) => { if (n.source) check(n, n.source.value) },
    ImportExpression: (n) => {
      if (n.source.type === 'Literal') check(n, n.source.value)
      // a template with no substitutions is a literal by another name (r-gates on I-0)
      else if (n.source.type === 'TemplateLiteral' && n.source.expressions.length === 0) check(n, n.source.quasis[0].value.cooked)
    },
    CallExpression: (n) => {
      if (n.callee.type === 'Identifier' && n.callee.name === 'require' && n.arguments[0]?.type === 'Literal') check(n, n.arguments[0].value)
    },
    // Type positions count too: `import('tldraw').TLShape` and `import x = require('tldraw')`
    // pull no runtime code, but they are still another package's material in the
    // engine (found by the auditor on I-0: a type import passed every zone).
    TSImportType: (n: unknown) => {
      const arg = (n as { argument?: { type: string; literal?: { value?: unknown } } }).argument
      if (arg?.type === 'TSLiteralType') check(n as Rule.Node, arg.literal?.value)
    },
    TSExternalModuleReference: (n: unknown) => {
      const e = (n as { expression?: { type: string; value?: unknown } }).expression
      if (e?.type === 'Literal') check(n as Rule.Node, e.value)
    },
  }
}

/** A relative import resolved to a repo-relative path; a bare specifier as written. */
function target(file: string, source: string): { local: string | null; bare: string | null } {
  if (source.startsWith('.') || source.startsWith('/')) {
    const abs = source.startsWith('/') ? source : path.resolve(path.dirname(file), source)
    return { local: rel(abs.split('?')[0]), bare: null }
  }
  return { local: null, bare: source }
}

const under = (p: string, dir: string) => p === dir || p.startsWith(dir + '/') || p.startsWith(dir + '.')

interface Zone {
  /** files this zone applies to (repo-relative directory prefixes) */
  files: string[]
  /** files inside the zone may not import these local directories... */
  noLocal?: string[]
  /** ...nor these packages (exact name or `name/…`) */
  noPackage?: string[]
  /** files OUTSIDE `files` may not import into it (a dark zone) */
  dark?: boolean
  /** directories outside the zone that a dark zone still lets in */
  darkExcept?: string[]
  message: string
}

// G-INV-06's engine half and I-0's dark zone (contracts C6.3). The new engines
// stay imported by nothing until the package that wires their switch adds its
// importer to `darkExcept`, in a reviewed diff of eslint.config.ts.
const importZones: Rule.RuleModule = {
  meta: { type: 'problem', schema: [{ type: 'array' }] },
  create(context) {
    const zones = (context.options[0] ?? []) as Zone[]
    const file = rel(context.filename)
    return onImport(context, (node, source) => {
      const t = target(context.filename, source)
      for (const z of zones) {
        const inside = z.files.some(d => under(file, d))
        if (inside) {
          if (t.local && z.noLocal?.some(d => under(t.local!, d))) context.report({ node, message: `${z.message} (imports ${t.local})` })
          if (t.bare && z.noPackage?.some(p => t.bare === p || t.bare!.startsWith(p + '/'))) context.report({ node, message: `${z.message} (imports ${t.bare})` })
        } else if (z.dark && t.local && z.files.some(d => under(t.local!, d)) && !z.darkExcept?.some(d => under(file, d))) {
          context.report({ node, message: `${z.message} (${t.local} is imported by nothing until its switch is wired)` })
        }
      }
    })
  },
}

// G-INV-04: code-based tests are banned (AGENTS.md, "Checks"). A test file by
// name, or an import of a test runner. A `test` script in package.json is
// caught by review, not here.
const RUNNERS = ['bun:test', 'node:test', 'vitest', 'jest', '@jest/globals', 'mocha', 'chai', 'ava', 'tap', 'uvu', 'jasmine', '@playwright/test', '@testing-library/react', '@testing-library/dom']
const noTests: Rule.RuleModule = {
  meta: { type: 'problem', schema: [] },
  create(context) {
    const file = rel(context.filename)
    const listeners = onImport(context, (node, source) => {
      // The browser-run driver is the `playwright` library root; every other entry point
      // it exports (`playwright/test`, `/lib/runner`, `/types/test`, ...) is its test
      // runner or that runner's machinery (r-gates on I-0: `playwright/test` passed).
      const playwrightRunner = source.startsWith('playwright/') && source !== 'playwright/package.json'
      if (playwrightRunner || RUNNERS.some(r => source === r || source.startsWith(r + '/'))) {
        context.report({ node, message: `Code-based tests are banned (AGENTS.md): no test runner may be imported (${source}). Verify with a browser run driving the real app.` })
      }
    })
    return {
      ...listeners,
      Program(node) {
        if (/(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) {
          context.report({ node, message: 'Code-based tests are banned (AGENTS.md): no *.test.* / *.spec.* file. Verify with a browser run driving the real app.' })
        }
      },
    }
  },
}

interface SinkAllow { file: string; names: string[]; rhs: 'any' | 'constant'; identifiers?: string[] }

// G-INV-22: HTML-string sinks occur only where listed (AGENTS.md: two places
// turn note text into innerHTML). Banned wherever the name appears; an
// allow-list entry is by path and, unless it is one of the two note-text sinks,
// requires a right-hand side that is a module constant built from literals.
const SINK_PROPS = new Set(['innerHTML', 'outerHTML', 'srcdoc', 'insertAdjacentHTML', 'setHTMLUnsafe', 'createContextualFragment'])
const htmlSinks: Rule.RuleModule = {
  meta: { type: 'problem', schema: [{ type: 'array' }] },
  create(context) {
    const allow = (context.options[0] ?? []) as SinkAllow[]
    const file = rel(context.filename)
    const entry = (name: string) => allow.find(a => a.file === file && a.names.includes(name))

    const isConstant = (n: Node | null | undefined, seen = new Set<string>()): boolean => {
      if (!n) return false
      if (n.type === 'Literal') return typeof (n as unknown as { value: unknown }).value === 'string'
      if (n.type === 'TemplateLiteral') return (n.expressions as Node[]).every(e => isConstant(e, seen))
      if (n.type === 'BinaryExpression' && n.operator === '+') return isConstant(n.left as Node, seen) && isConstant(n.right as Node, seen)
      if (n.type === 'Identifier') {
        const name = n.name as string
        if (seen.has(name)) return false
        seen.add(name)
        let scope: ReturnType<typeof context.sourceCode.getScope> | null = context.sourceCode.getScope(n)
        while (scope) {
          const v = scope.set.get(name)
          if (v) {
            const def = v.defs[0]
            return !!def && def.type === 'Variable' && (def.parent as { kind?: string }).kind === 'const' &&
              isConstant((def.node as unknown as { init: Node }).init, seen)
          }
          scope = scope.upper
        }
      }
      return false
    }

    const judge = (node: Rule.Node, name: string, rhs: Node | null) => {
      const e = entry(name)
      if (e && (e.rhs === 'any' || isConstant(rhs) || (rhs?.type === 'Identifier' && e.identifiers?.includes(rhs.name as string)))) return
      context.report({ node, message: `HTML-string sink \`${name}\` outside its allow-list (AGENTS.md: exactly two places turn note text into innerHTML). Build DOM nodes, or set textContent.` })
    }

    return {
      MemberExpression(n) {
        const prop = n.property
        const name = !n.computed && prop.type === 'Identifier' ? prop.name : prop.type === 'Literal' && typeof prop.value === 'string' ? prop.value : null
        if (!name) return
        const parent = (n as Node).parent as Node
        if (name === 'write' || name === 'writeln') {
          if (n.object.type === 'Identifier' && n.object.name === 'document') judge(n, `document.${name}`, null)
          return
        }
        if (name === 'parseFromString') {
          const call = parent.type === 'CallExpression' ? parent : null
          const type = call ? (call.arguments as Node[])[1] : null
          if (type?.type === 'Literal' && typeof type.value === 'string' && type.value !== 'text/html') return
          judge(n, name, null)
          return
        }
        if (!SINK_PROPS.has(name)) return
        const rhs = parent.type === 'AssignmentExpression' && parent.left === n ? parent.right as Node
          : parent.type === 'CallExpression' && parent.callee === n ? (parent.arguments as Node[]).at(-1) ?? null : null
        judge(n, name, rhs)
      },
      JSXAttribute(n: unknown) {
        const a = n as unknown as { name: { name: unknown } }
        const name = typeof a.name.name === 'string' ? a.name.name : null
        if (name === 'dangerouslySetInnerHTML' || name === 'srcDoc' || name === 'srcdoc') judge(n as Rule.Node, name, null)
      },
    }
  },
}

// G-INV-FS: only src/context/ touches the File System Access API (AGENTS.md,
// the four layers). Bans the method names only that API has. The baseline of
// files that break the rule today is the rule's option in eslint.config.ts and
// may only shrink. getFile and iteration are not banned by name (no type
// information can tell a handle from a Map); the browser runs cover them.
const FS_NAMES = new Set(['getFileHandle', 'getDirectoryHandle', 'createWritable', 'removeEntry', 'showDirectoryPicker', 'queryPermission', 'requestPermission', 'isSameEntry'])
const fsAccess: Rule.RuleModule = {
  meta: { type: 'problem', schema: [{ type: 'array' }] },
  create(context) {
    const baseline = new Set((context.options[0] ?? []) as string[])
    const file = rel(context.filename)
    if (under(file, 'src/context') || baseline.has(file)) return {}
    return {
      // the picker is also a global: a bare `showDirectoryPicker()` (r-gates on I-0)
      Identifier(n) {
        const parent = (n as Node).parent as Node
        if (FS_NAMES.has(n.name) && parent.type === 'CallExpression' && parent.callee === n) {
          context.report({ node: n, message: `File System Access call \`${n.name}\` outside src/context/ (AGENTS.md: the four layers). Go through useFileSystem().` })
        }
      },
      MemberExpression(n) {
        const prop = n.property
        const name = !n.computed && prop.type === 'Identifier' ? prop.name : prop.type === 'Literal' && typeof prop.value === 'string' ? prop.value : null
        if (name && FS_NAMES.has(name)) {
          context.report({ node: n, message: `File System Access call \`${name}\` outside src/context/ (AGENTS.md: the four layers). Go through useFileSystem().` })
        }
      },
    }
  },
}

// P1-dev exports every public symbol; the worker adapter may use only the
// canonical 136-export surface. An explicit dev import guard is also required
// so a static import cannot silently carry its manifest into a shipping chunk.
const pdfiumBoundaries: Rule.RuleModule = {
  meta: { type: 'problem', schema: [{ type: 'array', items: { type: 'string' } }] },
  create(context) {
    const allowed = new Set((context.options[0] ?? []) as string[])
    const file = rel(context.filename)
    const checkNative = (node: Rule.Node, value: unknown) => {
      if (typeof value !== 'string' || !/^_?(?:FPDF|FORM|FSDK)[A-Za-z0-9_]+$/.test(value)) return
      if (!allowed.has(value.replace(/^_/, ''))) context.report({ node, message: `PDFium symbol ${value} is not in src/pdf/engine/pdfium/exports.json (02-engine-build section 3).` })
    }
    const enabled = (test: Node): boolean => {
      const source = context.sourceCode.getText(test).replace(/\s+/g, '')
      return source === 'import.meta.env.DEV||__BME_BENCH__' || source === '__BME_BENCH__||import.meta.env.DEV'
    }
    const guarded = (node: Node): boolean => {
      let child = node
      for (let parent = node.parent as Node; parent; parent = parent.parent as Node) {
        if (parent.type === 'IfStatement' && parent.consequent === child && enabled(parent.test as Node)) return true
        if (parent.type === 'ConditionalExpression' && parent.consequent === child && enabled(parent.test as Node)) return true
        if (parent.type === 'LogicalExpression' && parent.operator === '&&' && parent.right === child && enabled(parent.left as Node)) return true
        child = parent
      }
      return false
    }
    return {
      ...onImport(context, (node, source) => {
        const local = target(context.filename, source).local
        if (!local || !under(local, 'src/pdf/engine/dev') || under(file, 'src/pdf/engine/dev')) return
        const n = node as Node
        if (n.importKind === 'type' || n.exportKind === 'type') return
        if (n.type !== 'ImportExpression' || !guarded(n)) context.report({ node, message: 'Import the development PDFium loader dynamically inside if (import.meta.env.DEV || __BME_BENCH__), never statically or from its production branch.' })
      }),
      Identifier(raw) {
        const n = raw as Node
        const parent = n.parent as Node
        if (typeof n.name === 'string' && (n.name.startsWith('_') || (parent.type === 'CallExpression' && parent.callee === n))) checkNative(n, n.name)
      },
      MemberExpression(raw) {
        const n = raw as Node
        const property = n.property as Node
        if (!n.computed && property.type === 'Identifier') checkNative(property, property.name)
      },
      Literal(raw) { const n = raw as Node; checkNative(n, n.value) },
      TemplateLiteral(raw) {
        const n = raw as Node
        const parts = n.quasis as unknown as { value: { cooked: string | null } }[]
        if (parts.length === 1) checkNative(n, parts[0].value.cooked)
      },
    }
  },
}

export const bmePlugin = {
  meta: { name: 'bme' },
  rules: { 'import-zones': importZones, 'no-tests': noTests, 'html-sinks': htmlSinks, 'fs-access': fsAccess, 'pdfium-boundaries': pdfiumBoundaries },
}

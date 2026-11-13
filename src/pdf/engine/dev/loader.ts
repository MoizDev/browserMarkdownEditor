import manifest from './manifest.json'

export type DevPdfiumRole = 'render' | 'writer'
export interface DevPdfiumOptions {
  compiledModule: WebAssembly.Module
  /** SHA-256-verified by the privileged pool before transfer to the opaque frame. */
  glueSource: string
  role: DevPdfiumRole
  onAbort?: (reason: string) => void
}
export interface DevPdfiumHeaps {
  readonly HEAPU8: Uint8Array
  readonly HEAPU32: Uint32Array
  readonly HEAP32: Int32Array
  readonly HEAPF32: Float32Array
  readonly HEAPF64: Float64Array
}
export interface DevPdfiumInstance extends DevPdfiumHeaps {
  module: Record<string, unknown>
  instance: WebAssembly.Instance
  buildId: string
}

/** The privileged pool fetches these; only its contained frame compiles them. */
export function devPdfiumAssets() {
  if (!(import.meta.env.DEV || __BME_BENCH__)) throw new Error('Development PDF engine is disabled')
  const prefix = `${import.meta.env.BASE_URL}__bme_pdfium_dev/${manifest.sha256}/`
  return {
    ...manifest,
    glueUrl: new URL(`${prefix}pdfium.js`, location.href).href,
    wasmUrl: new URL(`${prefix}pdfium.wasm`, location.href).href,
  }
}

/** Only a classic worker may call this; the contained frame supplies the module. */
export function instantiateDevPdfium(options: DevPdfiumOptions): Promise<DevPdfiumInstance> {
  if (!(import.meta.env.DEV || __BME_BENCH__)) throw new Error('Development PDF engine is disabled')
  return instantiate(options, manifest)
}

/** Prepend to the contained frame's classic blob-worker payload, not a module worker. */
export function createDevPdfiumRuntimeSource(): string {
  if (!(import.meta.env.DEV || __BME_BENCH__)) throw new Error('Development PDF engine is disabled')
  // No eval in the privileged page: this is source for the frame's classic blob
  // worker. Keeping the implementation self-contained also survives minification.
  return `globalThis.instantiateDevPdfium = options => (${instantiate.toString()})(options, ${JSON.stringify(manifest)});\n`
}

// This function is serialized into a classic blob worker. It must capture no
// module variables; the only data it receives is the committed identity above.
async function instantiate(options: DevPdfiumOptions, identity: typeof manifest): Promise<DevPdfiumInstance> {
  type Runtime = Record<string, unknown> & {
    Module?: Record<string, unknown>
    importScripts?: (...urls: string[]) => void
    getHeapMax?: () => number
    growMemory?: (size: number) => number
  }
  const scope = globalThis as unknown as Runtime
  if (typeof scope.importScripts !== 'function' || 'document' in globalThis) {
    throw new Error('PDFium requires a classic dedicated worker')
  }
  if (scope.Module) throw new Error('A PDFium instance already owns this worker')
  const roleLimit = options.role === 'render' ? 1_073_741_824
    : options.role === 'writer' ? 3_758_096_384 : 0
  if (!roleLimit) throw new Error('Unknown PDFium worker role')
  if (!(options.compiledModule instanceof WebAssembly.Module)) throw new Error('Missing frame-compiled PDFium module')
  // Measured in the real opaque blob worker: crypto.subtle is absent. Hash
  // verification belongs to the trusted pool before it transfers either asset;
  // the worker must not depend on a secure-context API its realm cannot expose.
  scope.Module = {}
  const glueBytes = new TextEncoder().encode(options.glueSource)
  if (glueBytes.byteLength !== identity.files.glue.bytes) throw new Error('PDFium glue length mismatch')
  const effectiveLimit = Math.min(roleLimit, identity.maximumMemoryBytes)
  let instance: WebAssembly.Instance | undefined
  let dead = false
  let resolveReady!: (value: DevPdfiumInstance) => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<DevPdfiumInstance>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const fail = (reason: string): never => {
    dead = true
    const error = new Error(reason)
    rejectReady(error)
    try { options.onAbort?.(reason) } catch { /* A reporting callback cannot rescue an aborted worker. */ }
    throw error
  }
  const memory = (): WebAssembly.Memory => {
    if (dead || !instance) throw new Error('PDFium instance is unavailable')
    const result = instance.exports.memory
    if (!(result instanceof WebAssembly.Memory)) return fail('PDFium memory export is missing')
    return result
  }
  const result: DevPdfiumInstance = {
    module: {}, instance: undefined as unknown as WebAssembly.Instance, buildId: identity.buildId,
    // Growth detaches the previous buffer. No view is retained across a native
    // call: callers reread these getters after anything that can allocate.
    get HEAPU8() { return new Uint8Array(memory().buffer) },
    get HEAPU32() { return new Uint32Array(memory().buffer) },
    get HEAP32() { return new Int32Array(memory().buffer) },
    get HEAPF32() { return new Float32Array(memory().buffer) },
    get HEAPF64() { return new Float64Array(memory().buffer) },
  }
  const settings: Record<string, unknown> = {
    noInitialRun: true,
    print: () => {}, printErr: () => {},
    locateFile: () => fail('The PDFium module must be compiled in the contained frame'),
    onAbort: () => fail('PDFium aborted'),
    onRuntimeInitialized: () => {
      if (!instance || dead) return
      result.instance = instance
      result.module = settings
      resolveReady(result)
    },
    instantiateWasm: (imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => {
      try {
        const env = imports.env
        const stockResize = env?.emscripten_resize_heap
        const stockMax = scope.getHeapMax
        const stockGrow = scope.growMemory
        if (typeof stockResize !== 'function' || typeof stockMax !== 'function' || typeof stockGrow !== 'function') {
          return fail('Pinned PDFium growth hooks are missing')
        }
        // The pinned stock resize clamps geometric overgrowth against getHeapMax.
        // Checking only requestedSize would let a near-cap render exceed 1 GiB.
        // Install before instantiation, not on Module after imports are captured.
        const max = Math.min(effectiveLimit, stockMax())
        scope.getHeapMax = () => max
        scope.growMemory = size => {
          if (!Number.isSafeInteger(size) || size < 0 || size > max) return fail(`heap-limit:${options.role}:${size}`)
          return stockGrow(size)
        }
        env.emscripten_resize_heap = (requested: number) => {
          const bytes = requested >>> 0
          if (bytes > max) return fail(`heap-limit:${options.role}:${bytes}`)
          const grew = stockResize(bytes)
          if (instance && memory().buffer.byteLength > max) return fail(`heap-limit:${options.role}:${bytes}`)
          if (!grew) return fail(`heap-limit:${options.role}:${bytes}`)
          return grew
        }
        instance = new WebAssembly.Instance(options.compiledModule, imports)
        if (memory().buffer.byteLength > max) return fail('PDFium initial memory exceeds its role limit')
        receive(instance, options.compiledModule)
        return instance.exports
      } catch (error) {
        dead = true
        rejectReady(error instanceof Error ? error : new Error('PDFium instantiation failed'))
        // Emscripten catches synchronous hook errors; reject our promise as well
        // so that its swallowed error cannot leave engine.init pending forever.
        return {}
      }
    },
  }
  scope.Module = settings
  const url = URL.createObjectURL(new Blob([options.glueSource], { type: 'text/javascript' }))
  try {
    scope.importScripts(url)
  } catch (error) {
    dead = true
    rejectReady(error instanceof Error ? error : new Error('PDFium glue failed'))
  } finally { URL.revokeObjectURL(url) }
  return ready
}

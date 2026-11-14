import exportMap from './exports.json';
import { validatePdfiumAbi } from './abi';
import type { PdfiumAbi } from './abi';
import { PdfEngineError } from '../types';
import type { PdfEngineRole } from '../types';

export type PdfiumCallback = (...args: number[]) => number | void;
export interface PdfiumLoadOptions {
    wasm: WebAssembly.Module;
    /** A verified glue blob minted in the same opaque realm as this worker. */
    glueUrl: string;
    abi: unknown;
    role: PdfEngineRole;
    buildId: string;
    artifactSha256: string;
    onAbort?: (reason: unknown) => void;
}
/** Worker-private native capability. Never place this object, pointers or heap
 * views in a pool reply; callers copy all returned data before crossing C5. */
export interface PdfiumRuntime {
    readonly abi: PdfiumAbi;
    readonly buildId: string;
    readonly artifactSha256: string;
    readonly role: PdfEngineRole;
    readonly HEAPU8: Uint8Array;
    readonly HEAPU32: Uint32Array;
    readonly HEAP32: Int32Array;
    readonly HEAPF32: Float32Array;
    readonly HEAPF64: Float64Array;
    readonly aborted: boolean;
    malloc(bytes: number): number;
    free(pointer: number): void;
    addFunction(callback: PdfiumCallback, signature: string): number;
    removeFunction(pointer: number): void;
    /** Initialize exactly once with an ABI-validated FPDF_LIBRARY_CONFIG. */
    initLibrary(configPointer: number): void;
    /** Only names in the canonical operation map are callable. */
    call(name: string, ...args: number[]): number;
    /** Caller closes all documents first; this releases library and callbacks. */
    dispose(): void;
}

type NativeFunction = (...args: number[]) => unknown;
type EmscriptenModule = Record<string, unknown> & {
    buildId: unknown;
    HEAPU8: Uint8Array; HEAPU32: Uint32Array; HEAP32: Int32Array;
    HEAPF32: Float32Array; HEAPF64: Float64Array;
    addFunction: (callback: PdfiumCallback, signature: string) => number;
    removeFunction: (pointer: number) => void;
};
type Factory = (options: {
    bmeRole: PdfEngineRole;
    onAbort: (reason: unknown) => void;
    instantiateWasm: (imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => void;
}) => Promise<EmscriptenModule>;

const nativeNames = exportMap.rows.flatMap(row => row.exports);
const nativeSet = new Set(nativeNames);
const runtimeExports = ['__wasm_call_ctors', 'setThrew', '_emscripten_stack_restore',
    '_emscripten_stack_alloc', 'emscripten_stack_get_current', 'memory', '__indirect_function_table'];
const expectedWasm = new Set([...nativeNames, ...exportMap.allocatorExports, ...runtimeExports]);
const broken = (message: string) => new PdfEngineError('EngineBroken', message);

/** Instantiate the host-verified module in its opaque worker, never in the app's realm. */
export async function loadPdfiumModule(options: PdfiumLoadOptions): Promise<PdfiumRuntime> {
    const abi = validatePdfiumAbi(options.abi);
    if (!(options.wasm instanceof WebAssembly.Module) || !/^(?:dev-)?[a-f0-9]{64}$/.test(options.buildId) ||
        !/^[a-f0-9]{64}$/.test(options.artifactSha256) || (options.role !== 'render' && options.role !== 'writer')) {
        throw broken('Invalid PDFium module identity or role');
    }
    if (typeof window !== 'undefined' || typeof location === 'undefined' || location.origin !== 'null' ||
        !options.glueUrl.startsWith('blob:null/')) throw broken('PDFium glue requires an opaque worker blob');
    const wasmExports = WebAssembly.Module.exports(options.wasm);
    if (nativeSet.size !== 138 || wasmExports.length !== expectedWasm.size ||
        wasmExports.some(entry => !expectedWasm.has(entry.name) || entry.kind !== (entry.name === 'memory' ? 'memory' : entry.name === '__indirect_function_table' ? 'table' : 'function'))) {
        throw broken('PDFium WASM export surface does not match its operation map');
    }
    let failed = false;
    let closed = false;
    let initialized = false;
    const callbacks = new Set<number>();
    let module: EmscriptenModule;
    try {
        const imported: unknown = await import(/* @vite-ignore */ options.glueUrl);
        if (!imported || typeof imported !== 'object' || typeof (imported as { default?: unknown }).default !== 'function') throw broken('Invalid PDFium ES module');
        const factory = (imported as { default: Factory }).default;
        module = await factory({
            bmeRole: options.role,
            onAbort: reason => {
                failed = true;
                try { options.onAbort?.(reason); } catch { /* An observer cannot interrupt engine teardown. */ }
            },
            instantiateWasm(imports, receive) {
                const instance = new WebAssembly.Instance(options.wasm, imports);
                receive(instance, options.wasm);
            },
        });
    } catch (error) {
        if (error instanceof PdfEngineError) throw error;
        throw broken('PDFium worker instantiation failed');
    }
    if (failed || !module || module.buildId !== options.buildId || typeof module.addFunction !== 'function' ||
        typeof module.removeFunction !== 'function' || !(module.HEAPU8 instanceof Uint8Array) ||
        !(module.HEAPU32 instanceof Uint32Array) || !(module.HEAP32 instanceof Int32Array) ||
        !(module.HEAPF32 instanceof Float32Array) || !(module.HEAPF64 instanceof Float64Array)) throw broken('PDFium glue identity or runtime is invalid');
    const maxHeap = options.role === 'render' ? 1024 ** 3 : 3.5 * 1024 ** 3;
    if (module.HEAPU8.byteLength > maxHeap) throw broken('PDFium role heap limit is invalid');
    for (const name of [...nativeNames, ...exportMap.allocatorExports]) {
        if (typeof module[`_${name}`] !== 'function') throw broken(`PDFium glue is missing ${name}`);
    }
    const ensure = () => { if (failed || closed) throw broken('PDFium instance is no longer usable'); };
    const invoke = (name: string, args: number[]): number => {
        ensure();
        try {
            const result = (module[`_${name}`] as NativeFunction)(...args);
            return typeof result === 'number' ? result : 0;
        } catch {
            failed = true;
            throw broken('PDFium native operation failed');
        }
    };
    return {
        abi, buildId: options.buildId, artifactSha256: options.artifactSha256, role: options.role,
        get HEAPU8() { ensure(); return module.HEAPU8; },
        get HEAPU32() { ensure(); return module.HEAPU32; },
        get HEAP32() { ensure(); return module.HEAP32; },
        get HEAPF32() { ensure(); return module.HEAPF32; },
        get HEAPF64() { ensure(); return module.HEAPF64; },
        get aborted() { return failed; },
        malloc(bytes) {
            if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 0xffffffff) throw new PdfEngineError('ResourceLimit', 'Invalid PDFium allocation size');
            const pointer = invoke('malloc', [bytes]) >>> 0;
            if (!pointer) throw new PdfEngineError('ResourceLimit', 'PDFium allocation failed');
            return pointer;
        },
        free(pointer) { if (pointer && !failed && !closed) invoke('free', [pointer]); },
        addFunction(callback, signature) {
            ensure();
            if (!/^[vijfdp][ijfdp]*$/.test(signature)) throw broken('Invalid PDFium callback signature');
            try {
                const pointer = module.addFunction(callback, signature);
                if (!Number.isSafeInteger(pointer) || pointer <= 0) throw broken('Invalid PDFium callback pointer');
                callbacks.add(pointer);
                return pointer;
            } catch (error) { if (error instanceof PdfEngineError) throw error; failed = true; throw broken('PDFium callback registration failed'); }
        },
        removeFunction(pointer) {
            if (!callbacks.delete(pointer) || failed || closed) return;
            try { module.removeFunction(pointer); } catch { failed = true; }
        },
        initLibrary(configPointer) {
            ensure();
            if (initialized || !Number.isSafeInteger(configPointer) || configPointer <= 0 || configPointer % 4 !== 0 || configPointer + abi.structs.libraryConfig.size > module.HEAPU8.byteLength) throw broken('Invalid PDFium library initialization');
            invoke('FPDF_InitLibraryWithConfig', [configPointer]);
            initialized = true;
        },
        call(name, ...args) {
            if (!nativeSet.has(name) || name === 'FPDF_InitLibraryWithConfig' || name === 'FPDF_DestroyLibrary') throw broken('PDFium operation is not available through this boundary');
            if (!initialized) throw broken('PDFium library is not initialized');
            return invoke(name, args);
        },
        dispose() {
            if (closed) return;
            if (initialized && !failed) { try { invoke('FPDF_DestroyLibrary', []); } catch { /* The worker is already unusable. */ } }
            for (const pointer of callbacks) { try { module.removeFunction(pointer); } catch { /* The worker is being disposed. */ } }
            callbacks.clear();
            initialized = false;
            closed = true;
        },
    };
}

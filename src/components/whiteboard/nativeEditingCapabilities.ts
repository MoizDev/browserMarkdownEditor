import type { NativeCanvasHost, NativeCanvasIdentity } from '../../types/nativeCanvas';
import type { NativeCommandOperation } from './nativeCommandSource';
import type { NativeClipboardService } from './useNativeClipboard';
import type { NativeViewLease } from './nativeViewLease';
import type { BoardTextQuestion } from './useNativeBoardDialogs';

/** App supplies all source-sensitive operations together. Embed creation/conversion remains inert;
 * only a later explicit per-embed Load may obtain the real containment capability. */
export interface NativeEditingCapabilities {
    readonly flatten: NativeCommandOperation;
    readonly insertEmbed: NativeCommandOperation;
    readonly convertToBookmark: NativeCommandOperation;
    readonly convertToEmbed: NativeCommandOperation;
    dispose(): void;
}
export interface NativeEditingCapabilityContext {
    readonly runtime: NativeViewLease['runtime'];
    readonly lease: NativeViewLease;
    readonly host: NativeCanvasHost;
    readonly identity: NativeCanvasIdentity;
    readonly clipboard: NativeClipboardService;
    readonly signal: AbortSignal;
    current(): boolean;
    canWrite(): boolean;
    requestText(question: BoardTextQuestion): Promise<string | null>;
    notice(message: string): void;
    t(key: string): string;
}
export type NativeEditingCapabilityFactory = (context: NativeEditingCapabilityContext) => Promise<NativeEditingCapabilities>;

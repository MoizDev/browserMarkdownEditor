import type { BinaryLike } from 'node:crypto';
import type { Metafile } from 'esbuild';

export function sha256Hex(bytes: BinaryLike): string;
export function hashInlineScript(runtime: string): string;
export function bundleContainedRuntime(options: { root: string; entry: string }): Promise<{
    runtime: string;
    hash: string;
    metafile: Metafile;
}>;

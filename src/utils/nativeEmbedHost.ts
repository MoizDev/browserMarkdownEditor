import type { NativeEmbedHost } from '../types/nativeCanvas';
import type { EmbedContainment, EmbedContainmentApproval, EmbedContainmentOptions } from '../platform/embedContainment.types';
import { EMBED_PROVIDER_ORIGINS } from '../platform/embedPolicy';
import { loadChunk } from '../platform/chunkLoad';

/** App-lifetime registry and lazy platform binding; documents cannot grant origins or consent. */
export function createNativeEmbedHost(): NativeEmbedHost {
    const manifest = Object.freeze({ version: 1 as const,
        origins: EMBED_PROVIDER_ORIGINS,
    });
    let approval: EmbedContainmentApproval | undefined;
    return Object.freeze({
        manifest,
        async create(options: EmbedContainmentOptions) {
            if (options.manifest.version !== manifest.version || !Array.isArray(options.manifest.origins)
                || options.manifest.origins.length !== manifest.origins.length
                || options.manifest.origins.some((origin, index) => origin !== manifest.origins[index])) {
                throw new Error('Embed providers do not match the App registry');
            }
            const platform = await loadChunk(() => import('../platform/embedContainment'));
            approval = platform.isEmbedContainmentApproved;
            return platform.createEmbedContainment({ ...options, manifest });
        },
        // This delegates to the platform's live private registry; loading its module
        // or matching manifest fields never manufactures a containment approval.
        approved: (value: unknown): value is EmbedContainment => approval?.(value) ?? false,
    });
}

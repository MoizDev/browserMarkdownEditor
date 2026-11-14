import type { PlatformLayerDefinition } from './attachPlatformPane.types';
import type { CompositorLayer, LayerHost } from './compositor.types';
import type { Layer } from './types';

interface BoundLayer {
    readonly definition: PlatformLayerDefinition;
    readonly layer: Layer;
    readonly compositor: CompositorLayer;
}

/** Definitions are immutable attachment identities. The lifecycle owns all layers after publication;
 * a failed construction only disposes new, unpublished layers, never an existing session's layer.
 */
export class PaneLayerSet {
    private bindings: readonly BoundLayer[] = [];

    constructor(private readonly makeHost: (id: string, current: () => Layer | null) => LayerHost) {}

    get layers(): readonly Layer[] { return this.bindings.map(binding => binding.layer); }
    get compositorLayers(): readonly CompositorLayer[] { return this.bindings.map(binding => binding.compositor); }

    definition(layer: Layer): PlatformLayerDefinition | undefined {
        return this.bindings.find(binding => binding.layer === layer)?.definition;
    }

    /** Returns the replacement without ending any published layer's life. The caller hands
     * removed layers to PaneLifecycle.setLayers, the only release/dispose route.
     */
    replace(definitions: readonly PlatformLayerDefinition[]): void {
        const ids = new Set<string>();
        for (const definition of definitions) {
            if (!definition.id || ids.has(definition.id)) throw new Error('Layer ids must be nonempty and unique');
            ids.add(definition.id);
        }
        const old = new Map(this.bindings.map(binding => [binding.definition, binding]));
        const previouslyOwned = new Set(this.bindings.map(binding => binding.layer));
        const seen = new Set<Layer>();
        const created: BoundLayer[] = [];
        const next: BoundLayer[] = [];
        try {
            for (const definition of definitions) {
                const retained = old.get(definition);
                if (retained) { seen.add(retained.layer); next.push(retained); continue; }
                let layer: Layer | null = null;
                const host = this.makeHost(definition.id, () => layer);
                layer = definition.create(host);
                if (seen.has(layer) || previouslyOwned.has(layer)) throw new Error('A layer cannot be shared by definitions');
                seen.add(layer);
                const owned = layer;
                const compositor: CompositorLayer = {
                    id: definition.id, layer: owned, group: definition.group, isolation: definition.isolation,
                    coverage: (frame, backend) => definition.coverage(owned, frame, backend),
                };
                const binding = { definition, layer: owned, compositor };
                created.push(binding);
                next.push(binding);
            }
        } catch (error) {
            const errors: unknown[] = [error];
            for (const binding of created) {
                try { binding.layer.dispose(); } catch (cleanup) { errors.push(cleanup); }
            }
            throw errors.length === 1 ? error : new AggregateError(errors, 'Layer construction failed');
        }
        this.bindings = Object.freeze(next);
    }
}

import { attachPlatformPane, registerCpuPaneFactory } from './attachPlatformPane';
import { createCompositor2D } from './compositor2d';

// Import from the lazy pane route, never App's initial chunk. Registration allocates no canvas,
// context or frame; the attach actor remains the sole owner of selection and layer lifetime.
registerCpuPaneFactory(createCompositor2D);

export { attachPlatformPane };
export type { PlatformLayerDefinition, PlatformPane, PlatformPaneOptions, PlatformPresentation } from './attachPlatformPane.types';

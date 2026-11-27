import { attachPlatformPane, registerCpuPaneFactory } from './attachPlatformPane';
import { createCompositor2D } from './compositor2d';

registerCpuPaneFactory(createCompositor2D);

export { attachPlatformPane };
export type { PlatformLayerDefinition, PlatformPane, PlatformPaneOptions, PlatformPresentation } from './attachPlatformPane.types';

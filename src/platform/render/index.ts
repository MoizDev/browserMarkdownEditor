// Consumer-facing rendering types. This barrel has no runtime backend, broker or scheduler imports.
export type { Camera, Rect, Viewport, ViewState } from '../types';
export type { AttachPlatformPane, PlatformLayerDefinition, PlatformPane, PlatformPaneOptions, PlatformPresentation } from './attachPlatformPane.types';
export type { CompositorLayer, CompositorLayerGroup, LayerCoverage, LayerHost, TexturedQuadOptions } from './compositor.types';
export type { FrameBudget, FrameToken, GpuReleaseReason, Layer, RenderToken } from './types';
export type { PageStack } from './pageStack';
export type { ByteLease, GfxDevice, GpuPass, TextureHandle, UniformSlice } from './gfx/api';
export type { BorrowedMirror, MirrorEntry, MirrorStorage, MirrorView } from './mirrorSet';
export type { TileKey } from './tiles/geometry';
export { createPlatformMirrors } from './createPlatformMirrors';
export { renderTokenKey } from './tiles/geometry';
export { attachPlatformPane } from './attachPlatformPane';

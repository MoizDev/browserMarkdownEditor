import type { ScenePaintRequest, SceneSpatial } from '../scene/types'
import type { PaintImageProvider } from '../render/resources'
import type { ReadExportImage } from './exportImage'
import type { PinExportSnapshot } from './snapshot'

/** The Scene pins first; asynchronous text/layout preparation reads only that snapshot. */
export function sceneExportPin(
  scene: SceneSpatial, request: ScenePaintRequest, images: PaintImageProvider, readImage: ReadExportImage,
  /** Selection is expanded to descendant node IDs by the owning selection service. */
  selectedNodeIds?: readonly string[],
): PinExportSnapshot {
  const frozen = { ...request, world: request.world && { ...request.world } }
  const selected = selectedNodeIds && new Set(selectedNodeIds)
  return () => {
    const lease = scene.pin()
    return { token: lease.token, revision: lease.revision, images, readImage,
      async paintSource(signal) {
        const source = await lease.paintSource(frozen, signal)
        if (!selected) return source
        return { token: source.token, sceneRevision: source.sceneRevision, nodeCount: source.nodeCount,
          isCurrent: () => source.isCurrent(), readNode(index) {
            const node = source.readNode(index)
            return { underlay: node.underlay?.filter(item => selected.has(item.nodeId)),
              content: node.content.filter(item => selected.has(item.nodeId)) }
          } }
      }, release: () => lease.release() }
  }
}

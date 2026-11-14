import type { CameraController } from '../../platform/render/camera'
import type { InputToken } from './tool'

export interface RevealBounds { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface RevealIdentity { readonly token: InputToken; readonly selection: string | null }
export interface RevealServices {
  readonly camera: CameraController
  current(identity: RevealIdentity): boolean
  presented(): { readonly camera: { readonly x: number; readonly y: number; readonly z: number }; readonly usable: RevealBounds; readonly direction: 'ltr' | 'rtl' }
  bounds(identity: RevealIdentity): Promise<RevealBounds | null> | RevealBounds | null
  changed(): void
}
export interface SelectionReveal {
  request(identity: RevealIdentity): void
  refresh(): void
  cancel(): void
  dispose(): void
}

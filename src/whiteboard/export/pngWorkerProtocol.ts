export type PngWorkerRequest =
  | { kind: 'start'; width: number; height: number; clipboard?: boolean; pixelsPerWorldUnit?: number }
  | { kind: 'row'; row: Uint8Array }
  | { kind: 'end' }
  | { kind: 'cancel' }

export type PngWorkerResponse =
  | { kind: 'pull' }
  | { kind: 'result'; blob: Blob }
  | { kind: 'error'; message: string }

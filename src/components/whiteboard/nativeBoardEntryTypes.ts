import type { BoardSessionPort } from './boardSessionAdapter';
import type { DrawingSessionViewProps } from './DrawingSessionView';
import type { PagedSessionViewProps } from './PagedSessionView';
import type { NativeBoardAcquisitionOptions } from './nativeBoardAcquisitionTypes';

type WithoutOwner<T> = T extends unknown ? Omit<T, 'adapter' | 'emergencyReadOnly'> : never;
export type NativeDrawingEntryProps<T extends object, S extends BoardSessionPort> =
    WithoutOwner<DrawingSessionViewProps<T, S>> & { readonly acquisition: NativeBoardAcquisitionOptions<S> };
export type NativePagedEntryProps<T extends object, S extends BoardSessionPort> =
    WithoutOwner<PagedSessionViewProps<T, S>> & { readonly acquisition: NativeBoardAcquisitionOptions<S> };

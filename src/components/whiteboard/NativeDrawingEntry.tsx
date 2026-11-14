import DrawingSessionView from './DrawingSessionView';
import type { BoardSessionPort } from './boardSessionAdapter';
import type { NativeDrawingEntryProps } from './nativeBoardEntryTypes';
import { useNativeBoardAcquisition } from './useNativeBoardAcquisition';

/** Lazy C-21 entry: acquisition registers one App-owned session before attaching a pane. */
export default function NativeDrawingEntry<T extends object, S extends BoardSessionPort>(props: NativeDrawingEntryProps<T, S>) {
    const { acquisition, ...view } = props;
    const acquired = useNativeBoardAcquisition(acquisition);
    if (!acquired) return view.loading;
    return <DrawingSessionView {...view} adapter={acquired.adapter} emergencyReadOnly={acquired.emergencyReadOnly} />;
}

import PagedSessionView from './PagedSessionView';
import type { BoardSessionPort } from './boardSessionAdapter';
import type { NativePagedEntryProps } from './nativeBoardEntryTypes';
import { useNativeBoardAcquisition } from './useNativeBoardAcquisition';

/** Notebook and PDF ink share the same session-acquisition and view-lease lifecycle. */
export default function NativePagedEntry<T extends object, S extends BoardSessionPort>(props: NativePagedEntryProps<T, S>) {
    const acquired = useNativeBoardAcquisition(props.acquisition);
    if (!acquired) return props.loading;
    if (props.kind === 'notebook') {
        const { acquisition: _acquisition, ...view } = props;
        return <PagedSessionView {...view} adapter={acquired.adapter} emergencyReadOnly={acquired.emergencyReadOnly} />;
    }
    const { acquisition: _acquisition, ...view } = props;
    return <PagedSessionView {...view} adapter={acquired.adapter} emergencyReadOnly={acquired.emergencyReadOnly} />;
}

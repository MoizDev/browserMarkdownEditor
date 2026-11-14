import type { ViewState } from '../../platform/types';

/** Exact paired-band draw state, not the later requested camera or desired omission. */
export interface ViewerPaintPresentation {
    readonly view: ViewState;
    readonly omittedNodeIds: ReadonlySet<string> | null;
}

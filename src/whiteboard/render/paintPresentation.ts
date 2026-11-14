import type { ViewState } from '../../platform/types';
import type { FrameToken } from '../../platform/render/types';

/** Exact paired-band draw state, not the later requested camera or desired omission. */
export interface ViewerPaintPresentation {
    readonly view: ViewState;
    readonly frameId: number;
    readonly token: FrameToken;
    readonly omittedNodeIds: ReadonlySet<string> | null;
    /** Retains the actual raw source frame, not its omission/ink presentation wrapper. */
    retain(): () => void;
}

import { AlertCircle } from './icons';
import { canvasReadOnlyReason, type CanvasSniff } from '../utils/canvasFormat';
import './CanvasReadOnlyNotice.css';

/** A refusal REPLACES the editor; covering a live blank canvas would leave its
 *  shortcuts, agent reporter and close-flush able to replace the original. */
export default function CanvasReadOnlyNotice({ sniff }: { sniff: CanvasSniff }) {
    return (
        <div className="canvas-readonly-notice" role="status" data-canvas-format={sniff.format}
            onContextMenu={event => event.preventDefault()}>
            <div className="canvas-readonly-card">
                <span className="canvas-readonly-icon" aria-hidden="true"><AlertCircle size={28} /></span>
                <h2>Read-only drawing</h2>
                <p>{canvasReadOnlyReason(sniff)}</p>
                <p className="canvas-readonly-preserved">The original file has not been changed. No edits will be saved.</p>
            </div>
        </div>
    );
}

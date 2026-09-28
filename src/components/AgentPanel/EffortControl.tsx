// How hard the model thinks, for models that report effort levels. The aicss
// slider when there are two or more levels; a plain line when there is one.

import { ReasoningEffort } from './aicss/ReasoningEffort';
import { effortLabel } from './useAgentChat';

export interface EffortControlProps {
    levels: string[];
    value: string;
    onChange: (effort: string) => void;
}

export function EffortControl({ levels, value, onChange }: EffortControlProps) {
    if (levels.length === 0) return null;
    return (
        <div className="agent-effort">
            <div className="agent-effort-head">
                <span>Effort</span>
                <span className="agent-effort-value">{effortLabel(value)}</span>
            </div>
            {levels.length > 1 && (
                <ReasoningEffort levels={levels} value={value} onChange={onChange} format={effortLabel} />
            )}
        </div>
    );
}

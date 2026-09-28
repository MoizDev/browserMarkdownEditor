// Adapted from AICSS's ThinkingState (MIT, © 2026 AICSS — see LICENSE-aicss;
// https://www.aicss.dev/components/thinking-state). Changed: takes a label;
// colours come from the panel's tokens (aicss.css) instead of :global blocks.

export function ThinkingState({ label = 'Thinking' }: { label?: string }) {
    return <span className="aic-shimmer">{label}</span>;
}

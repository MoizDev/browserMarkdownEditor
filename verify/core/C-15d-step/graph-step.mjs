// C-15's one real-app P/B/D flow, plus strict step samples and the approved
// drawing-clock scope witness. Never use this observer arm for timing numbers.
process.argv.push('--step-ms=require');
await import('../C-15d/graph-hooks.mjs');

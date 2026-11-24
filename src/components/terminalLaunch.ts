// What the terminal's button and chord do OUTSIDE the lazy terminal chunk: dial
// the helper from inside the click. Main-chunk code with no xterm and no static
// import of the bridge — it reaches it through a dynamic import, like
// agentUpdateHint, so a session that never opens a terminal fetches nothing.
//
// THE LNA RULE (agentBridge.ts): no request reaches 127.0.0.1 on page load
// unless autoConnect's gate passes. A click is the user's own Connect, so it
// may dial directly — Chrome's Local Network Access prompt can then appear,
// which is exactly what the user just asked for. A dock RESTORED open on load
// is not a click and goes through autoConnect() in the panel instead.

export function connectHelperForTerminal(): void {
    import('../utils/agentBridge').then(({ agentBridge }) => {
        const s = agentBridge.getState();
        // 'idle' = waiting for this click; a 'failed' with no redial scheduled
        // is waiting for one too (the screen's Retry). Anything else is already
        // dialling, connected, updating, or retrying by itself.
        if (s.status === 'idle' || (s.status === 'failed' && s.retryAt == null)) void agentBridge.connect();
    }).catch(() => { /* the dock's own gate reports problems */ });
}

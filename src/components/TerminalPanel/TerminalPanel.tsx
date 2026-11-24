// The terminal dock's content: a header of tabs over the active shell's xterm.
//
// Only a view. The shells, their xterms and the connection live in
// `terminalStore` (outside React), so hiding the dock — or switching vaults —
// takes none of them down. `data-terminal` on the root is load-bearing: App's
// ⌘E and EditorPane's Alt chords skip events that start inside it, so the keys
// reach the shell instead of flipping a note's mode behind it (⌘S, ⌘N, ⌘\ and
// ⌃` stay app-wide, as in the agent panel).

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { HELPER_NAME } from '../../../shared/vaultAgentProtocol';
import { agentBridge } from '../../utils/agentBridge';
import { openContextMenu } from '../../utils/contextMenu';
import type { ContextMenuEntry } from '../../utils/contextMenu';
import { detectArch, detectOs, isChromium } from '../../utils/platform';
import type { CpuArch } from '../../utils/platform';
import { HelperGate } from '../HelperGate/HelperGate';
import { gatePasses } from '../HelperGate/gate';
import { ChevronDown, Plus, SquareTerminal, X } from '../icons';
import { terminalStore } from './terminalStore';
import type { SessionView } from './terminalStore';

/** How long after opening the terminal may still take the keyboard from where it
 *  was, while the connection and the first shell come up. Past it, a reader who
 *  went on typing in their note keeps it (the agent panel's rule). */
const OPEN_FOCUS_WINDOW_MS = 1500;
const FDA_DISMISSED_KEY = 'terminalFdaNoticeDismissed';

function readDismissed(): boolean {
    try { return localStorage.getItem(FDA_DISMISSED_KEY) === '1'; } catch { return false; }
}

/** One shell's terminal, adopted into the body. Keyed by the session, so a tab
 *  switch is an unmount (release the old host) and a mount (adopt the new). */
function Surface({ sessionKey, onOpened }: { sessionKey: string; onOpened: (key: string) => void }) {
    const ref = useRef<HTMLDivElement>(null);

    // A layout effect: the host must be in the DOM before the first paint, or the
    // body flashes empty on every tab switch.
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        let live = true;
        void terminalStore.attachView(sessionKey, el).then(() => { if (live) onOpened(sessionKey); });
        return () => {
            live = false;
            terminalStore.detachView(sessionKey, el);
        };
    }, [sessionKey, onOpened]);

    // Every size change — the window, the dock's drag, the sidebar — is a re-fit,
    // at most one per frame: the terminal's rows and columns follow the box.
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        let frame = 0;
        const observer = new ResizeObserver(() => {
            if (frame) return;
            frame = requestAnimationFrame(() => {
                frame = 0;
                terminalStore.refit(sessionKey);
            });
        });
        observer.observe(el);
        return () => {
            observer.disconnect();
            if (frame) cancelAnimationFrame(frame);
        };
    }, [sessionKey]);

    return <div className="terminal-surface" ref={ref} />;
}

function Tab({ session, active, onSelect, onKill }: {
    session: SessionView;
    active: boolean;
    onSelect: (key: string) => void;
    onKill: (key: string) => void;
}) {
    const gone = session.status === 'exited' || session.status === 'ended' || session.status === 'detached';
    // The strip scrolls sideways with no scrollbar: a tab that becomes active
    // past its edge (a new one, or ←/→) must be brought into view (measured: at
    // 9 tabs in a narrow dock the active one sat outside the strip).
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (active) ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [active]);
    return (
        <div ref={ref} role="presentation" className={'terminal-tab' + (active ? ' is-active' : '') + (gone ? ' is-gone' : '')}>
            <button
                type="button"
                role="tab"
                aria-selected={active}
                className="terminal-tab-main"
                onClick={() => onSelect(session.key)}
            >
                <SquareTerminal size={13} strokeWidth={1.9} />
                <span className="terminal-tab-title">{session.title}</span>
            </button>
            <button
                type="button"
                className="terminal-tab-close"
                aria-label={`Kill ${session.title}`}
                data-tooltip="Kill this terminal"
                onClick={() => onKill(session.key)}
            >
                <X size={12} />
            </button>
        </div>
    );
}

export default function TerminalPanel({ takeFocus, onHide }: { takeFocus: boolean; onHide: () => void }) {
    const bridge = useSyncExternalStore(agentBridge.subscribeState, agentBridge.getState);
    const state = useSyncExternalStore(terminalStore.subscribe, terminalStore.getState);
    const [os] = useState(detectOs);
    const [supported] = useState(() => isChromium() && os !== 'other' && typeof WebSocket === 'function');
    const [arch, setArch] = useState<CpuArch>('x64');
    const [fdaDismissed, setFdaDismissed] = useState(readDismissed);
    const rootRef = useRef<HTMLDivElement>(null);

    // Restored shells (a reload) must be in the first paint, not appear a frame
    // late: init() reads them, and a layout effect's state change re-renders
    // before the browser paints.
    useLayoutEffect(() => { terminalStore.init(); }, []);

    // ── The keyboard in and out (AgentPanel's pattern) ──
    // Opening hands the keyboard to the terminal; closing hands it back to
    // whatever had it, or else to the focused note. Only an open the reader
    // asked for takes it: a dock restored open with the page leaves the
    // keyboard to the note being restored.
    const wantsFocus = useRef(takeFocus);
    const returnFocusTo = useRef<Element | null>(null);
    const openedAt = useRef(0);
    // A layout effect so its cleanup runs while the dock is still in the
    // document — after removal, focus inside it has already fallen to <body>.
    useLayoutEffect(() => {
        const before = document.activeElement;
        returnFocusTo.current = before && before !== document.body ? before : null;
        openedAt.current = performance.now();
        return () => {
            const active = document.activeElement;
            // Hidden from outside (the footer button) with the keyboard elsewhere: leave it there.
            if (active && active !== document.body && !active.closest('[data-terminal]')) return;
            const back = returnFocusTo.current;
            if (back instanceof HTMLElement && back.isConnected && !back.closest('[data-terminal]')) {
                back.focus({ preventScroll: true });
                return;
            }
            const slot = document.querySelector('.editor-slot.is-focused');
            const note = slot?.querySelector<HTMLElement>('.cm-content[contenteditable="true"]') ?? slot?.querySelector<HTMLElement>('.cm-scroller');
            note?.focus({ preventScroll: true });
        };
    }, []);
    const onOpened = useCallback((key: string) => {
        if (!wantsFocus.current) return;
        wantsFocus.current = false;
        const active = document.activeElement;
        const unmoved = !active || active === document.body || !!rootRef.current?.contains(active)
            || (active === returnFocusTo.current && performance.now() - openedAt.current < OPEN_FOCUS_WINDOW_MS);
        if (unmoved) terminalStore.focus(key);
    }, []);

    // Hold the connection while the dock is open, and dial by itself only where
    // agentBridge.autoConnect says that cannot raise Chrome's prompt. (A click on the
    // button already dialled: terminalLaunch.)
    useEffect(() => {
        if (!supported) return;
        const release = agentBridge.retain();
        void agentBridge.autoConnect();
        return release;
    }, [supported]);

    useEffect(() => {
        if (os !== 'linux') return;
        let live = true;
        void detectArch().then(a => { if (live) setArch(a); });
        return () => { live = false; };
    }, [os]);

    const passes = supported && gatePasses(bridge, 'terminal');
    // Opening the dock with no shell starts one — never in the moment after the
    // reader killed the last (the store knows), and not before the helper is there.
    useEffect(() => {
        if (passes) terminalStore.ensureOne();
    }, [passes, state.sessions.length]);

    // Chrome closes the tab on Ctrl+W, and a page cannot stop it (outside fullscreen);
    // in a terminal Ctrl+W is "delete word". While focus is in here, leaving the
    // page asks first — better a prompt than a lost session. macOS uses ⌘W, which
    // nobody types into a shell.
    useEffect(() => {
        const root = rootRef.current;
        if (!root || os === 'macos') return;
        let armed = false;
        const guard = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
        const arm = (on: boolean) => {
            if (on === armed) return;
            armed = on;
            if (on) window.addEventListener('beforeunload', guard);
            else window.removeEventListener('beforeunload', guard);
        };
        const onIn = () => arm(true);
        const onOut = (e: FocusEvent) => { if (!root.contains(e.relatedTarget as Node | null)) arm(false); };
        root.addEventListener('focusin', onIn);
        root.addEventListener('focusout', onOut);
        return () => {
            root.removeEventListener('focusin', onIn);
            root.removeEventListener('focusout', onOut);
            arm(false);
        };
    }, [os]);

    const connect = useCallback(() => { void agentBridge.connect(); }, []);
    const update = useCallback(() => { void agentBridge.update(); }, []);

    const select = useCallback((key: string) => {
        if (terminalStore.getState().activeKey === key) {
            // Already the active tab: its surface does not remount, so nothing else would give it the keyboard.
            terminalStore.focus(key);
            return;
        }
        // The new tab's surface mounts next and takes the keyboard when it is open.
        wantsFocus.current = true;
        terminalStore.select(key);
    }, []);
    const kill = useCallback((key: string) => {
        terminalStore.close(key);
        // Killing the last shell hides the dock, as in VS Code; otherwise the
        // neighbour that takes over gets the keyboard the × button just lost.
        if (terminalStore.getState().sessions.length === 0) onHide();
        else wantsFocus.current = true;
    }, [onHide]);
    const add = useCallback(() => {
        wantsFocus.current = true;
        terminalStore.create();
    }, []);

    const activeKey = state.activeKey;
    // The gate stands in for the terminal only while there is nothing to show: once a
    // shell has been live, a dropped connection is the dock's "Reconnecting…" line,
    // not a setup screen that would hide a running session.
    const showGate = !passes && !state.sessions.some(s => s.status !== 'starting');

    const onContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
        // The browser's own menu never shows here (AGENTS.md: the app draws every
        // one), whatever happens next.
        e.preventDefault();
        const key = activeKey;
        if (!key || !(e.target as Element).closest('.terminal-body')) return;
        // A program that asked for mouse events owns the right-click — unless Shift is held,
        // the terminal convention for "I mean the terminal's menu".
        if (terminalStore.mouseTracking(key) && !e.shiftKey) return;
        const selected = terminalStore.hasSelection(key);
        const entries: ContextMenuEntry[] = [
            {
                kind: 'command', id: 'copy', label: 'Copy', disabled: !selected,
                reason: selected ? undefined : 'Nothing is selected',
                run: () => terminalStore.copySelection(key),
            },
            {
                kind: 'command', id: 'paste', label: 'Paste',
                run: async () => { await terminalStore.paste(key); terminalStore.focus(key); },
            },
            { kind: 'command', id: 'select-all', label: 'Select All', run: () => terminalStore.selectAll(key) },
            { kind: 'command', id: 'clear', label: 'Clear', run: () => terminalStore.clear(key) },
            { kind: 'separator', id: 'sep' },
            { kind: 'command', id: 'new', label: 'New Terminal', run: add },
            { kind: 'command', id: 'kill', label: 'Kill Terminal', danger: true, run: () => kill(key) },
        ];
        openContextMenu({
            x: e.clientX,
            y: e.clientY,
            label: 'Terminal',
            // The keyboard goes back to the shell, not to a canvas that cannot take it.
            opener: rootRef.current?.querySelector<HTMLElement>('.xterm-helper-textarea') ?? null,
            entries,
        });
    };

    const onTabsKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const keys = state.sessions.map(s => s.key);
        const at = activeKey ? keys.indexOf(activeKey) : -1;
        const next = keys[(at + (e.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length];
        if (next === undefined) return;
        e.preventDefault();
        select(next);
    };

    const dismissFda = () => {
        try { localStorage.setItem(FDA_DISMISSED_KEY, '1'); } catch { /* asked again next time */ }
        setFdaDismissed(true);
    };
    const showFda = state.privacy?.backend === 'ptyhost' && state.privacy.fullDiskAccess === false && !fdaDismissed && !showGate;
    const reconnecting = !showGate && bridge.status !== 'connected' && state.sessions.some(s => s.status === 'live');
    // A failure the bridge will NOT redial by itself (something else on the port,
    // a refused permission): "Reconnecting…" would be a promise nobody keeps
    // (measured: it sat there 40 s after the helper was back). The reader retries.
    const stalled = reconnecting && bridge.status === 'failed' && bridge.retryAt === null;

    return (
        <div ref={rootRef} className="terminal-panel" data-terminal="" onContextMenu={onContextMenu}>
            <header className="terminal-header">
                <div className="terminal-tabs" role="tablist" aria-label="Terminals" onKeyDown={onTabsKeyDown}>
                    {state.sessions.map(s => (
                        <Tab key={s.key} session={s} active={s.key === activeKey} onSelect={select} onKill={kill} />
                    ))}
                </div>
                <button
                    type="button"
                    className="terminal-icon-btn"
                    aria-label="New terminal"
                    data-tooltip="New terminal"
                    onClick={add}
                    disabled={!passes}
                >
                    <Plus size={14} />
                </button>
                <span className="terminal-header-spacer" />
                {reconnecting && (stalled ? (
                    <span className="terminal-status">
                        Disconnected from {HELPER_NAME} · <button type="button" className="terminal-notice-btn" onClick={connect}>Reconnect</button>
                    </span>
                ) : <span className="terminal-status">Reconnecting to {HELPER_NAME}…</span>)}
                <button
                    type="button"
                    className="terminal-icon-btn"
                    aria-label="Hide the terminal"
                    data-tooltip="Hide (⌃`)"
                    onClick={onHide}
                >
                    <ChevronDown size={15} />
                </button>
            </header>

            {state.notice && <div className="terminal-notice" role="status">{state.notice}</div>}
            {showFda && (
                <div className="terminal-notice" role="status">
                    <span className="terminal-notice-text">
                        Documents, Desktop and iCloud Drive ask once for access. To never be asked, give <b>vaultagent-pty</b> Full Disk Access.
                    </span>
                    <span className="terminal-notice-actions">
                        <button type="button" className="terminal-notice-btn" onClick={() => void terminalStore.openPrivacySettings()}>Open Settings</button>
                        <button type="button" className="terminal-notice-btn" onClick={() => void terminalStore.revealPtyHost()}>Show in Finder</button>
                        <button type="button" className="terminal-notice-btn" onClick={dismissFda}>Dismiss</button>
                    </span>
                </div>
            )}

            {showGate ? (
                <div className="terminal-gate">
                    <HelperGate
                        requirement="terminal"
                        supported={supported}
                        bridge={bridge}
                        os={os}
                        arch={arch}
                        onConnect={connect}
                        onUpdate={update}
                        noun="the terminal"
                        title="Set up the terminal"
                        lede="Your own shell, in a real terminal: your profile, your prompt, your commands, starting in your home folder. It runs through VaultAgent, a small helper you install once."
                    />
                </div>
            ) : (
                <div className="terminal-body">
                    {activeKey && <Surface key={activeKey} sessionKey={activeKey} onOpened={onOpened} />}
                </div>
            )}
        </div>
    );
}

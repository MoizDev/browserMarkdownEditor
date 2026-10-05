// The AI agent panel: a right-docked column App mounts lazily (index.tsx). It
// fills whatever box App gives it; App owns the width, the resize handle, the
// toggle button and ⌘⇧X.
//
// This component is only a view. The connection (utils/agentBridge.ts) and the
// chats and the run (chatStore.ts) are module stores that outlive it, so
// closing the panel mid-reply loses nothing and the agent's tool calls keep
// being answered.
//
// `data-agent-panel` on the root is load-bearing: App's global shortcut
// handler ignores ⌘E whose target is inside it (it would flip the mode of the
// note behind, unseen); ⌘S, ⌘N and ⌘\ stay app-wide.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DragEvent, MouseEvent as ReactMouseEvent } from 'react';
import { AGENT_IDS, AGENT_LABELS, HELPER_NAME } from '../../../shared/vaultAgentProtocol';
import type { AgentHost, AgentPanelProps } from '../../types/vaultAgent';
import { createAgentHosts, type AgentHostDeps } from '../../utils/agentHost';
import { agentBridge, BridgeError, helperReady } from '../../utils/agentBridge';
import type { BridgeState } from '../../utils/agentBridge';
import { getTerminalCount } from '../../utils/terminalCount';
import { detectArch, detectOs, installerAsset, isChromium } from '../../utils/platform';
import type { CpuArch } from '../../utils/platform';
import { openContextMenu } from '../../utils/contextMenu';
import type { ContextMenuEntry } from '../../utils/contextMenu';
import { CLIPBOARD_READ_BLOCKED, CLIPBOARD_WRITE_BLOCKED, copyText, readClipboardText } from '../../utils/clipboard';
import { MoreHorizontal, Sparkles, SquarePen, X } from '../icons';
import { ChatList } from './ChatList';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { ModelPicker } from './ModelPicker';
import { TeachToggle } from './TeachToggle';
import { AgentWarning, SetupGuide } from './SetupGuide';
import { UpdateBar } from './UpdateBar';
import { DRAFT_KEY, activeChatOf, chatStore, configOf, resolveModel } from './chatStore';
import type { ChatStoreState, Conversation, PreparedImage } from './chatStore';
import { HEALTH_CAPTION, agentHealth, useBridgeState, useChatState } from './useAgentChat';

const EMPTY: Conversation = { items: [], history: 'none' };

const WAIT_FOR_UPDATE = 'Wait for the update to finish';

/** "1 open terminal" / "3 open terminals" — the count the terminal chunk keeps
 *  in a tiny store, so this chunk never imports the terminal's. */
function terminalsPhrase(n: number): string {
    return `${n} open terminal${n === 1 ? '' : 's'}`;
}

/** Resolves once no run is in flight (a stopped one ends on its run.done), or after `timeoutMs`. */
function runEnded(timeoutMs: number): Promise<void> {
    return new Promise(resolve => {
        if (!chatStore.getState().run) { resolve(); return; }
        const done = () => { window.clearTimeout(timer); off(); resolve(); };
        const timer = window.setTimeout(done, timeoutMs);
        const off = chatStore.subscribe(() => { if (!chatStore.getState().run) done(); });
    });
}

/** How long after opening the composer may still take the keyboard from where
 *  it was, while the connection or the agent check is still coming up. Past
 *  it, a reader who went on typing in their note keeps it. */
const OPEN_FOCUS_WINDOW_MS = 1500;

/**
 * The panel's mark: the app's own AI glyph, the same one the sidebar button
 * carries, tinted by the connection (`data-state`, inked in AgentPanel.css).
 *
 * It replaced an aicss orb — a 3x3 lattice of dots, which at 22px in the top
 * corner read as a menu grid and said "agent" to nobody. The orb still does the
 * work it is good at: the animated ones in the conversation, where motion IS
 * the message.
 */
function StatusMark({ bridge, running }: { bridge: BridgeState; running: boolean }) {
    let label: string;
    let state: 'working' | 'on' | 'connecting' | 'off';
    if (bridge.status === 'connected' && bridge.helper.outdated) {
        label = `${HELPER_NAME} ${bridge.helper.version} needs an update`;
        state = 'off';
    } else if (bridge.status === 'connected') {
        label = running ? 'Working…' : `Connected to ${HELPER_NAME} ${bridge.helper.version}`;
        state = running ? 'working' : 'on';
    } else if (bridge.status === 'updating') {
        label = `Updating ${HELPER_NAME}…`;
        state = 'connecting';
    } else if (bridge.status === 'connecting' || bridge.status === 'checking' || (bridge.status === 'failed' && bridge.retryAt != null)) {
        label = 'Connecting…';
        state = 'connecting';
    } else {
        label = `Not connected to ${HELPER_NAME}`;
        state = 'off';
    }
    return (
        <span className="agent-status" data-state={state} data-tooltip={label}>
            <Sparkles size={17} role="img" aria-label={label} />
        </span>
    );
}

/** Why the composer cannot send, or null. */
function blockedReason(state: ChatStoreState, vaultOpen: boolean, conversation: Conversation): string | null {
    if (!vaultOpen) return 'Open a vault to chat';
    if (conversation.history === 'missing') return 'History unavailable here — start a new chat';
    if (conversation.history === 'loading') return 'Loading this chat…';
    const { agent } = configOf(state);
    const status = state.agents.find(a => a.agent === agent);
    if (!status) return state.agentsStatus === 'error' ? `Couldn't check ${AGENT_LABELS[agent]}` : 'Checking agents…';
    if (!status.installed || status.loggedIn === false) return `${AGENT_LABELS[agent]} isn't ready`;
    if (state.run && state.run.chatId !== (state.activeChatId ?? DRAFT_KEY)) return 'Another chat is replying…';
    return null;
}

/** Built once per page, like the stores it feeds: chatStore and an in-flight
 *  run keep this object, so it must outlive every mount of the panel. */
let sharedHost: AgentHost | null = null;
function hostFor(getDeps: () => AgentHostDeps): AgentHost {
    return (sharedHost ??= createAgentHosts(getDeps));
}

export default function AgentPanel({ vault, theme, getHostDeps, takeFocus, onClose }: AgentPanelProps) {
    const host = hostFor(getHostDeps);
    const bridge = useBridgeState();
    const state = useChatState();
    const [os] = useState(detectOs);
    const [supported] = useState(() => isChromium() && os !== 'other' && typeof WebSocket === 'function');
    const [arch, setArch] = useState<CpuArch>('x64');
    const [panelError, setPanelError] = useState<string | null>(null);
    const dropHandler = useRef<((files: File[]) => void) | null>(null);
    const [dragging, setDragging] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    // ── The keyboard in and out ──
    // Opening hands the keyboard to the composer; closing hands it back to
    // whatever had it (an Edit-mode caret, the footer button) or else to the
    // focused note, the way EditorPane gives a note the keyboard (its
    // scroller — a note in Reading mode leaves <body> focused). Only an open
    // the reader asked for takes it: a panel restored open with the page
    // leaves the keyboard to the note being restored.
    const takeFocusAtMount = useRef(takeFocus);
    const returnFocusTo = useRef<Element | null>(null);
    const wantsComposer = useRef(false);
    const openedAt = useRef(0);
    // A layout effect so its cleanup runs while the panel is still in the
    // document — after removal, focus inside it has already fallen to <body>
    // and there is no telling "the reader was in the panel" from "elsewhere".
    useLayoutEffect(() => {
        const before = document.activeElement;
        returnFocusTo.current = before && before !== document.body ? before : null;
        wantsComposer.current = takeFocusAtMount.current;
        openedAt.current = performance.now();
        return () => {
            const active = document.activeElement;
            // Closed from outside (the footer button) with the keyboard
            // elsewhere: leave it there.
            if (active && active !== document.body && !active.closest('[data-agent-panel]')) return;
            const back = returnFocusTo.current;
            if (back instanceof HTMLElement && back.isConnected && !back.closest('[data-agent-panel]')) {
                back.focus({ preventScroll: true });
                return;
            }
            const slot = document.querySelector('.editor-slot.is-focused');
            const note = slot?.querySelector<HTMLElement>('.cm-content[contenteditable="true"]') ?? slot?.querySelector<HTMLElement>('.cm-scroller');
            note?.focus({ preventScroll: true });
        };
    }, []);
    // The composer exists only once connected, and is disabled until the
    // agent check lands — so this waits for it, every render until then.
    useEffect(() => {
        if (!wantsComposer.current) return;
        const field = rootRef.current?.querySelector<HTMLTextAreaElement>('.agent-textarea');
        if (!field || field.disabled) return;
        wantsComposer.current = false;
        const active = document.activeElement;
        // <body> is nobody's keyboard (a Reading-mode note, a Connect button
        // that went away as it connected); where the reader was when they
        // opened the panel is theirs again once the window has passed.
        const unmoved = !active || active === document.body || !!rootRef.current?.contains(active)
            || (active === returnFocusTo.current && performance.now() - openedAt.current < OPEN_FOCUS_WINDOW_MS);
        if (unmoved) field.focus({ preventScroll: true });
    });

    const vaultKey = vault?.key ?? null;
    const vaultName = vault?.name ?? '';
    useEffect(() => {
        chatStore.attach(host, vaultKey ? { key: vaultKey, name: vaultName } : null);
    }, [host, vaultKey, vaultName]);

    useEffect(() => {
        if (os !== 'linux') return;
        let live = true;
        void detectArch().then(a => { if (live) setArch(a); });
        return () => { live = false; };
    }, [os]);

    // Hold the connection while the panel is open, and dial by itself only
    // where agentBridge.autoConnect says that cannot raise Chrome's prompt.
    useEffect(() => {
        if (!supported) return;
        const release = agentBridge.retain();
        void agentBridge.autoConnect();
        return release;
    }, [supported]);

    // A socket to a helper — possibly an outdated one, there only to be
    // updated or uninstalled. `ready` is the one the chat may use.
    const connected = bridge.status === 'connected';
    const updating = bridge.status === 'updating';
    const ready = supported && helperReady(bridge);

    // A chat opened before the connection was up gets its history now.
    const active = activeChatOf(state);
    const activeConversation = state.conversations[state.activeChatId ?? DRAFT_KEY];
    useEffect(() => {
        if (ready && active && !activeConversation) void chatStore.loadHistory(active);
    }, [ready, active, activeConversation]);

    useEffect(() => {
        if (!panelError) return;
        const id = window.setTimeout(() => setPanelError(null), 8000);
        return () => window.clearTimeout(id);
    }, [panelError]);

    const registerDrop = useCallback((handler: ((files: File[]) => void) | null) => {
        dropHandler.current = handler;
    }, []);

    const connect = useCallback(() => { void agentBridge.connect(); }, []);

    // The bar's button, the outdated screen's and the menu row can all be
    // pressed again while the question below is up or the reply is stopping;
    // the bridge ignores a second update, this keeps a second question away.
    const updateStarting = useRef(false);
    const doUpdate = useCallback(async () => {
        if (updateStarting.current) return;
        updateStarting.current = true;
        try {
            // A restart ends every shell the helper runs, so they are asked
            // about in the same question as a reply in flight — one prompt, not two.
            const replying = !!chatStore.getState().run;
            const shells = getTerminalCount();
            if (replying || shells > 0) {
                const ok = await host.ask(replying ? {
                    title: 'Stop the reply and update?',
                    body: shells > 0
                        ? `${HELPER_NAME} restarts to update, which ends the reply in progress and ${terminalsPhrase(shells)}. Your chats are kept.`
                        : `${HELPER_NAME} restarts to update, which ends the reply in progress. Your chats are kept.`,
                    confirmLabel: 'Stop and update',
                } : {
                    title: `Update ${HELPER_NAME}?`,
                    body: `Updating restarts ${HELPER_NAME} and ends ${terminalsPhrase(shells)}.`,
                    confirmLabel: 'Update',
                });
                if (!ok) return;
            }
            if (replying) {
                // The helper refuses to update while a run is live.
                await chatStore.stop();
                // A stopped run ends when its run.done arrives; updating before
                // that would abandon it too, stacking a second notice on it.
                await runEnded(5000);
            }
            await agentBridge.update();
        } finally {
            updateStarting.current = false;
        }
    }, [host]);
    const update = useCallback(() => { void doUpdate(); }, [doUpdate]);

    const uninstall = async () => {
        const shells = getTerminalCount();
        const ok = await host.ask({
            title: `Uninstall ${HELPER_NAME}?`,
            body: `This stops ${HELPER_NAME}${shells > 0 ? `, which ends ${terminalsPhrase(shells)},` : ''} removes it from your login items and deletes it from this computer. Your chats are kept. To use the agent again, download and open the installer.`,
            confirmLabel: 'Uninstall',
            danger: true,
        });
        if (!ok) return;
        if (chatStore.getState().run) await chatStore.stop();
        try {
            await agentBridge.request('helper.uninstall', {});
        } catch (e) {
            // It answers before it goes; a socket that closed first means it went.
            if (!(e instanceof BridgeError && e.code === 'disconnected')) {
                setPanelError(`Couldn't uninstall ${HELPER_NAME}: ${e instanceof Error ? e.message : String(e)}`);
                return;
            }
        }
        chatStore.onUninstalled();
        agentBridge.markUninstalled();
    };

    /** The ⋯ menu's Update row, for a helper that can update itself — in
     *  place of "Download installer", which is for one that cannot. */
    const updateRow = (): ContextMenuEntry | null => {
        if (updating) {
            return { kind: 'command', id: 'update', label: `Updating ${HELPER_NAME}…`, run: () => {}, disabled: true, reason: WAIT_FOR_UPDATE };
        }
        if (bridge.status !== 'connected' || !bridge.helper.selfUpdate) return null;
        const status = bridge.update;
        const label = `Update ${HELPER_NAME}`;
        switch (status.kind) {
            case 'unsupported': return null;
            case 'available':
                return { kind: 'command', id: 'update', label: `${label} to ${status.latest}`, run: update };
            case 'checking':
                return { kind: 'command', id: 'update', label, run: update, disabled: true, reason: 'Checking for updates…' };
            case 'current':
            case 'updated':
                return {
                    kind: 'command', id: 'update', label, run: update, disabled: true,
                    reason: `${HELPER_NAME} ${bridge.helper.version} is the latest version`,
                };
            // The helper checks again as it starts, and a failure brings back
            // the bar with the installer download.
            case 'unknown':
            case 'failed':
                return { kind: 'command', id: 'update', label, run: update };
        }
    };

    const openMenu = (e: ReactMouseEvent<HTMLButtonElement>) => {
        const button = e.currentTarget;
        const r = button.getBoundingClientRect();
        const asset = installerAsset(os, arch);
        // Which CLI runs the next chat lives HERE rather than in the header: the
        // header carried a dot, a name and a chevron for a choice that is made
        // once and then not thought about, and the panel is 400px wide. The
        // status it used to show is still surfaced where it matters — the
        // warning above the composer when the chosen agent is not ready.
        void chatStore.refreshAgents(false);
        // Cached by the helper, so asking on every open is cheap; the row is
        // built from what is known now and the bar picks up the answer.
        void agentBridge.checkForUpdate(false);
        const agentRows: ContextMenuEntry[] = ready ? [
            ...AGENT_IDS.map(id => ({
                kind: 'command' as const,
                id: `agent-${id}`,
                // A pick-one menu: `checked` on every row draws the ✓ column.
                label: `${AGENT_LABELS[id]} · ${HEALTH_CAPTION[agentHealth(state, id)]}`,
                checked: id === config.agent,
                disabled: !!run,
                reason: run ? 'Wait for the reply to finish' : undefined,
                run: () => { if (id !== config.agent) chatStore.selectAgent(id); },
            })),
            { kind: 'separator', id: 'sep-agent' },
        ] : [];
        // Only what a connected helper said of itself in `hello`: with none
        // (or mid-update, when the one that answered may already be gone) the
        // menu shows no version rather than a stale or blank one.
        const versionRows: ContextMenuEntry[] = bridge.status === 'connected' && bridge.helper.version ? [
            { kind: 'label', id: 'version', label: bridge.helper.version, tooltip: `${HELPER_NAME} version` },
            { kind: 'separator', id: 'sep-version' },
        ] : [];
        openContextMenu({
            x: Math.round(r.left),
            y: Math.round(r.bottom),
            label: `${HELPER_NAME} menu`,
            opener: button,
            anchor: button,
            entries: [
                ...versionRows,
                ...agentRows,
                {
                    kind: 'command', id: 'reconnect', label: 'Reconnect', run: connect,
                    disabled: !supported || updating,
                    // A reason is the row's tooltip, so only a dead row gets
                    // one (measured: an enabled Uninstall said "Connect to
                    // VaultAgent first" on hover while connected).
                    reason: updating ? WAIT_FOR_UPDATE : !supported ? 'Not available in this browser' : undefined,
                },
                updateRow() ?? {
                    kind: 'command', id: 'download', label: 'Download installer',
                    run: () => { if (asset) window.open(asset.url, '_blank', 'noopener,noreferrer'); },
                    disabled: !asset, reason: asset ? undefined : `${HELPER_NAME} has no build for this system`,
                },
                { kind: 'separator', id: 'sep' },
                {
                    kind: 'command', id: 'uninstall', label: `Uninstall ${HELPER_NAME}…`, danger: true,
                    run: uninstall, disabled: !connected,
                    reason: updating ? WAIT_FOR_UPDATE : connected ? undefined : `Connect to ${HELPER_NAME} first`,
                },
            ],
        });
    };

    // The app draws every context menu itself (AGENTS.md): Copy for what is
    // selected anywhere in the panel, and in the message box Paste as well —
    // there the menu opens with nothing selected too, since pasting needs no
    // selection. A row that cannot act stays and says why (app-context-menu).
    const onContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
        e.preventDefault();
        const selection = window.getSelection()?.toString() ?? '';
        const target = e.target as HTMLElement;
        const field = target instanceof HTMLTextAreaElement ? target : null;
        const fieldText = field ? field.value.slice(field.selectionStart, field.selectionEnd) : '';
        const text = fieldText || selection;
        if (!text && !field) return;
        const entries: ContextMenuEntry[] = [{
            kind: 'command',
            id: 'copy',
            label: 'Copy',
            disabled: !text,
            reason: text ? undefined : 'Nothing is selected',
            run: async () => { if (!await copyText(text)) host.notify(CLIPBOARD_WRITE_BLOCKED); },
        }];
        if (field) {
            entries.push({
                kind: 'command',
                id: 'paste',
                label: 'Paste',
                disabled: field.disabled,
                reason: field.disabled ? field.placeholder : undefined,
                run: async () => {
                    // A menu row's clipboard read is permission-gated (the
                    // right-click is spent by now), so a refusal is ordinary;
                    // naming ⌘V is the whole handling.
                    const read = await readClipboardText();
                    if (!read.ok) { host.notify(CLIPBOARD_READ_BLOCKED); return; }
                    if (!read.text || !field.isConnected || field.disabled) return;
                    field.focus();
                    // insertText rather than a value write: the paste lands on
                    // the field's own undo stack (⌘Z takes it back) and raises
                    // the input event React's onChange reads. The selection it
                    // replaces is the field's own, kept while the menu was up.
                    if (!document.execCommand('insertText', false, read.text)) {
                        field.setRangeText(read.text, field.selectionStart, field.selectionEnd, 'end');
                        field.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                },
            });
        }
        openContextMenu({ x: e.clientX, y: e.clientY, label: 'Agent panel', opener: target, entries });
    };

    // Every drop is cancelled, image or not: an uncancelled drop navigates the
    // app away to the file, taking unsaved buffers with it.
    const onDragOver = (e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        const hasFiles = Array.from(e.dataTransfer.types).includes('Files');
        e.dataTransfer.dropEffect = hasFiles && dropHandler.current ? 'copy' : 'none';
        if (hasFiles && dropHandler.current && !dragging) setDragging(true);
    };
    const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
    };
    const onDrop = (e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setDragging(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length && dropHandler.current) dropHandler.current(files);
    };

    const key = state.activeChatId ?? DRAFT_KEY;
    const conversation = state.conversations[key] ?? EMPTY;
    const config = configOf(state);
    const run = state.run;
    const runHere = !!run && run.chatId === key;
    const agentStatus = state.agents.find(a => a.agent === config.agent) ?? null;
    const model = resolveModel(state.models[config.agent]?.models, config.model);
    const blocked = blockedReason(state, !!vault, conversation);

    const send = (text: string, images: PreparedImage[]) => { void chatStore.send(text, images); };
    const stop = () => { void chatStore.stop(); };

    return (
        <div
            ref={rootRef}
            className={'agent-panel' + (dragging ? ' is-dropping' : '')}
            data-agent-panel=""
            data-theme={theme}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onContextMenu={onContextMenu}
        >
            <header className="agent-header">
                <StatusMark bridge={bridge} running={!!run} />
                {ready ? <ChatList state={state} theme={theme} /> : <span className="agent-header-title">AI agent</span>}
                <span className="agent-header-spacer" />
                {ready && (
                    <button
                        type="button"
                        className="agent-icon-btn"
                        aria-label="New chat"
                        data-tooltip="New chat"
                        onClick={() => chatStore.newChat()}
                    >
                        <SquarePen size={15} />
                    </button>
                )}
                <button type="button" className="agent-icon-btn" aria-label={`${HELPER_NAME} menu`} data-tooltip="More" onClick={openMenu}>
                    <MoreHorizontal size={16} />
                </button>
                <button type="button" className="agent-icon-btn" aria-label="Close the agent panel" data-tooltip="Close (⌘⇧X)" onClick={onClose}>
                    <X size={15} />
                </button>
            </header>

            {ready && <UpdateBar helper={bridge.helper} update={bridge.update} os={os} arch={arch} onUpdate={update} />}
            {panelError && <div className="agent-notice error agent-panel-error" role="alert">{panelError}</div>}

            {ready ? (
                <>
                    <MessageList
                        conversation={conversation}
                        run={run}
                        runHere={runHere}
                        theme={theme}
                        host={host}
                        onRetryHistory={() => { if (active) void chatStore.loadHistory(active); }}
                    />
                    <div className="agent-footer">
                        {!runHere && (
                            <AgentWarning
                                agent={config.agent}
                                status={agentStatus}
                                onRecheck={() => void chatStore.refreshAgents(true)}
                            />
                        )}
                        <Composer
                            blockedReason={runHere ? null : blocked}
                            running={runHere}
                            stopping={runHere && run?.phase === 'stopping'}
                            imagesAllowed={model ? model.images : true}
                            chip={<>
                                <ModelPicker state={state} theme={theme} disabled={!!blocked && !runHere} />
                                <TeachToggle state={state} />
                            </>}
                            onSend={send}
                            onStop={stop}
                            registerDrop={registerDrop}
                        />
                    </div>
                </>
            ) : (
                <div className="agent-setup">
                    <SetupGuide supported={supported} bridge={bridge} os={os} arch={arch} onConnect={connect} onUpdate={update} />
                </div>
            )}
        </div>
    );
}

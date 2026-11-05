// The AI agent panel: a right-docked column App mounts lazily (index.tsx). It
// fills whatever box App gives it; App owns the width, the resize handle, the
// toggle button and ⌘⇧X.
//
// This component is only a view. The connection (utils/agentBridge.ts) and the
// chats and the run (chatStore.ts) are module stores that outlive it, so
// closing the panel mid-reply loses nothing and the agent's tool calls keep
// being answered.
//
// Its layout is one chat column: a quiet header (title · chats · new chat · ⋯
// · close), then either the new-chat screen — greeting, the composer centred
// in the column, suggestion chips — or the conversation with the composer
// docked at the bottom. The composer is ONE element in both: it keeps its
// place in the tree and the layout around it changes, so the first send can
// move it (one eased transform, FLIP) instead of remounting it.
//
// `data-agent-panel` on the root is load-bearing: App's global shortcut
// handler ignores ⌘E whose target is inside it (it would flip the mode of the
// note behind, unseen); ⌘S, ⌘N and ⌘\ stay app-wide.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { AGENT_LABELS, HELPER_NAME } from '../../../shared/vaultAgentProtocol';
import type { AgentHost, AgentPanelProps } from '../../types/vaultAgent';
import { createAgentHosts, type AgentHostDeps } from '../../utils/agentHost';
import { agentBridge, BridgeError, hasConnectedBefore, helperReady } from '../../utils/agentBridge';
import type { BridgeState } from '../../utils/agentBridge';
import { getTerminalCount } from '../../utils/terminalCount';
import { AGENT_LOGIN_HINTS, detectArch, detectOs, isChromium } from '../../utils/platform';
import type { CpuArch } from '../../utils/platform';
import { openContextMenu } from '../../utils/contextMenu';
import type { ContextMenuEntry } from '../../utils/contextMenu';
import { CLIPBOARD_READ_BLOCKED, CLIPBOARD_WRITE_BLOCKED, copyText, readClipboardText } from '../../utils/clipboard';
import { SquarePen, X } from './ui/icons';
import { IconButton } from './ui/IconButton';
import { Shimmer } from './ui/Shimmer';
import { ChatList } from './ChatList';
import { Composer } from './Composer';
import { Greeting, Suggestions } from './EmptyState';
import { useFocusedNote } from './useFocusedNote';
import { MessageList } from './MessageList';
import { ModelPicker } from './ModelPicker';
import { MoreMenu } from './MoreMenu';
import { SetupGuide } from './SetupGuide';
import { TitleMenu } from './TitleMenu';
import { ToolsMenu } from './ToolsMenu';
import { UpdateBar, UpdateProgress } from './UpdateBar';
import { useBridgeState, useChatState } from './useAgentChat';
import { DRAFT_KEY, activeChatOf, chatStore, configOf, resolveModel } from './chatStore';
import { discardDraft } from './drafts';
import { emptyTree } from '../../utils/chatTree';
import type { ChatStoreState, Conversation, PreparedImage } from './chatStore';

const EMPTY: Conversation = { items: [], tree: emptyTree(), history: 'none' };

/** The first send's move from the centre to the bottom: one eased transform,
 *  long enough to follow, short enough not to hold up the first reply. */
const DOCK_MS = 250;
const DOCK_EASE = 'cubic-bezier(0.2, 0, 0, 1)';

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

/** A command the caption tells you to run; a click copies it. */
function CopyCommand({ command }: { command: string }) {
    const [copied, setCopied] = useState(false);
    const timer = useRef(0);
    useEffect(() => () => clearTimeout(timer.current), []);
    const copy = async () => {
        if (!(await copyText(command))) return;
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1200);
    };
    return (
        <button type="button" className="agent-cap-cmd" aria-label={copied ? 'Copied' : `Copy ${command}`} data-tooltip={copied ? 'Copied' : 'Copy'} onClick={copy}>
            <code>{command}</code>
        </button>
    );
}

interface ComposerState {
    /** The placeholder when the composer cannot send; null = it can. */
    blocked: string | null;
    caption: ReactNode;
    tone: 'std' | 'fix' | 'warn';
}

const STD_CAPTION = 'Edits land in your editor and undo with ⌘Z.';

/**
 * What the composer says. Blocked: the placeholder states the reason once and
 * the caption under it carries the fix (the command, copyable, and "check
 * again"). A login that could not be confirmed leaves the composer live and
 * only puts an amber sentence in the caption: sending may well work.
 */
function composerState(state: ChatStoreState, vaultOpen: boolean, conversation: Conversation, runHere: boolean, onRecheck: () => void): ComposerState {
    const std: ComposerState = { blocked: null, caption: STD_CAPTION, tone: 'std' };
    if (runHere) return std;
    if (!vaultOpen) return { ...std, blocked: 'Open a vault to chat' };
    if (conversation.history === 'missing') return { ...std, blocked: 'History unavailable here — start a new chat' };
    if (conversation.history === 'loading') return { ...std, blocked: 'Loading this chat…' };
    const { agent } = configOf(state);
    const name = AGENT_LABELS[agent];
    const status = state.agents.find(a => a.agent === agent);
    const recheck = <button type="button" className="agent-text-btn is-accent" onClick={onRecheck}>check again</button>;
    if (!status) {
        return state.agentsStatus === 'error'
            ? { blocked: `Couldn't check ${name}`, caption: <>Is {HELPER_NAME} still running? Then {recheck}.</>, tone: 'fix' }
            : { ...std, blocked: `Checking ${name}…` };
    }
    if (!status.installed) {
        return { blocked: `${name} isn't installed`, caption: <>Install it with <CopyCommand command={status.installCommand} /> in a terminal, then {recheck}.</>, tone: 'fix' };
    }
    const login = <CopyCommand command={status.loginCommand} />;
    // `claude` alone opens the CLI; /login inside it is the actual step.
    const loginNote = status.loginCommand.trim() === 'claude' && AGENT_LOGIN_HINTS[agent].note ? ` and ${AGENT_LOGIN_HINTS[agent].note.replace(/^then /, '')}` : '';
    if (status.loggedIn === false) {
        return { blocked: `${name} isn't logged in`, caption: <>Run {login} in a terminal{loginNote}, then {recheck}.</>, tone: 'fix' };
    }
    if (state.run && state.run.chatId !== (state.activeChatId ?? DRAFT_KEY)) return { ...std, blocked: 'Another chat is replying…' };
    if (status.loggedIn === null) {
        return { blocked: null, caption: <>Couldn't confirm you're logged in to {name}. If sending fails, run {login}{loginNote}, then {recheck}.</>, tone: 'warn' };
    }
    return std;
}

/** Built once per page, like the stores it feeds: chatStore and an in-flight
 *  run keep this object, so it must outlive every mount of the panel. */
let sharedHost: AgentHost | null = null;
function hostFor(getDeps: () => AgentHostDeps): AgentHost {
    return (sharedHost ??= createAgentHosts(getDeps));
}

/** Connected, or on the way there: the panel shows the chat (the composer
 *  inert, one shimmering line saying so) rather than a setup screen that
 *  would flash for the second it takes. Deciding on load counts only for a
 *  browser that has connected before — a first visit lands on the guide. */
function connectingNow(bridge: BridgeState): boolean {
    return bridge.status === 'connecting' || (bridge.status === 'checking' && hasConnectedBefore());
}

/** A chat-ready helper answered on this page (and was not uninstalled since).
 *  Module state, like the bridge it shadows: the panel closes and reopens,
 *  the page's history with the helper does not. */
let chatLiveThisPage = false;

/** The bridge is redialling a helper this page was chatting with: the socket
 *  dropped (`lost`), or the redial has not found it yet (`not-found`), with a
 *  retry scheduled — or that redial is under way. The conversation stays on
 *  screen with one quiet line; the gate is for what needs the reader (not
 *  installed, outdated, foreign, blocked) or a bridge that gave up (`retryAt`
 *  null). Measured before: a drop mid-reply swapped the whole chat for a
 *  "Connection lost" screen until the redial landed — with the real helper's
 *  backoff (1 s → 30 s), for up to half a minute at a time. */
function reconnectingNow(bridge: BridgeState): boolean {
    if (!chatLiveThisPage) return false;
    if (bridge.status === 'connecting') return true;
    return bridge.status === 'failed' && bridge.retryAt != null
        && (bridge.problem.kind === 'lost' || bridge.problem.kind === 'not-found');
}

/** An update of a helper the chat was using: the conversation stays readable
 *  under a progress line (UpdateBar's UpdateProgress). An outdated helper's
 *  update, started from its gate, keeps the gate's own progress screen —
 *  there was no chat to keep. */
function updatingChat(bridge: BridgeState): bridge is Extract<BridgeState, { status: 'updating' }> {
    return bridge.status === 'updating' && !bridge.helper.outdated;
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
    const fillHandler = useRef<((text: string) => void) | null>(null);
    const [dragging, setDragging] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const footerRef = useRef<HTMLDivElement>(null);

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
            const noteEl = slot?.querySelector<HTMLElement>('.cm-content[contenteditable="true"]') ?? slot?.querySelector<HTMLElement>('.cm-scroller');
            noteEl?.focus({ preventScroll: true });
        };
    }, []);
    // The composer is disabled until connected and the agent check lands —
    // so this waits for it, every render until then.
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
    const ready = supported && helperReady(bridge);
    const reconnecting = supported && reconnectingNow(bridge);
    const connecting = supported && (reconnecting || connectingNow(bridge));
    const updating = supported && updatingChat(bridge) ? bridge : null;
    const chatUi = ready || connecting || !!updating;
    useEffect(() => {
        if (ready) chatLiveThisPage = true;
        else if (bridge.status === 'uninstalled') chatLiveThisPage = false;
    }, [ready, bridge.status]);

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
    const registerFill = useCallback((handler: ((text: string) => void) | null) => {
        fillHandler.current = handler;
    }, []);

    const connect = useCallback(() => { void agentBridge.connect(); }, []);
    // The gate's Connect goes with the gate as the chat comes up, and took the
    // keyboard to <body> with it (measured, on a panel restored open with the
    // page, so no open asked for the composer). Once the box can take it, it
    // does — unless the reader has gone elsewhere meanwhile (the effect above).
    const connectFromGate = useCallback(() => {
        wantsComposer.current = true;
        void agentBridge.connect();
    }, []);

    const composerField = () => rootRef.current?.querySelector<HTMLTextAreaElement>('.agent-textarea') ?? null;

    // New chat's button goes with the conversation it ends, taking the
    // keyboard to <body> (measured, by click and by Enter): the box takes it,
    // since writing is what a new chat is for. It is the same element on both
    // screens, so it can take it now. The new chat's parked draft is dropped first — New chat
    // starts empty; every other chat keeps its own (drafts.ts).
    const newChat = () => {
        discardDraft(DRAFT_KEY);
        chatStore.newChat();
        const field = composerField();
        if (field && !field.disabled) field.focus({ preventScroll: true });
    };

    // "check again" lives in the caption it can make disappear (measured:
    // the keyboard fell to <body>). Once the agent is ready the keyboard goes
    // to the box it unblocked; still blocked, back to "check again" itself.
    const recheck = useCallback(() => {
        void chatStore.refreshAgents(true).then(() => requestAnimationFrame(() => {
            const root = rootRef.current;
            const active = document.activeElement;
            if (!root || (active && active !== document.body && !root.contains(active))) return;
            const field = root.querySelector<HTMLTextAreaElement>('.agent-textarea');
            if (field && !field.disabled) { field.focus({ preventScroll: true }); return; }
            if (!active || active === document.body) root.querySelector<HTMLElement>('.agent-caption .agent-text-btn')?.focus({ preventScroll: true });
        }));
    }, []);

    // The strip's button, the outdated screen's and the menu row can all be
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
    // app away to the file, taking unsaved buffers with it. A drop anywhere on
    // the panel lands in the composer; the composer alone lights up for it.
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
    const model = resolveModel(state.models[config.agent]?.models, config.model);
    const composer = composerState(state, !!vault, conversation, runHere, recheck);
    const inert = !ready;
    // "Empty" is a chat with nothing to show — not one whose history is still
    // loading, missing or failed: those keep the conversation's own notices.
    const empty = conversation.items.length === 0
        && conversation.history !== 'loading' && conversation.history !== 'missing' && conversation.history !== 'error';
    // The open note feeds only the new-chat screen's line and chips: watching
    // its selection with a chat open cost a describe() per keystroke in the
    // note (measured: 86 typed characters → 86 calls).
    const note = useFocusedNote(chatUi && empty);

    // ── The first send: the composer docks ──
    // Its top is measured as the send leaves (dockFrom), and once the layout
    // has flipped to the conversation it is moved back there with a transform
    // and let go — one eased move, nothing remounted. Any other way of
    // leaving the new-chat screen (opening a chat) has no dockFrom and no move.
    const dockFrom = useRef<number | null>(null);
    useLayoutEffect(() => {
        const from = dockFrom.current;
        if (empty || from == null) return;
        dockFrom.current = null;
        const footer = footerRef.current;
        if (!footer || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const delta = from - footer.getBoundingClientRect().top;
        if (Math.abs(delta) < 1) return;
        footer.animate([{ transform: `translateY(${delta}px)` }, { transform: 'none' }], { duration: DOCK_MS, easing: DOCK_EASE });
    }, [empty]);

    const send = (text: string, images: PreparedImage[]) => {
        if (empty && footerRef.current) dockFrom.current = footerRef.current.getBoundingClientRect().top;
        void chatStore.send(text, images);
    };
    const stop = () => { void chatStore.stop(); };

    // ── Esc, panel-wide ──
    // One press does one thing: an open popover closes (its own handler, on
    // the document — so this leaves it alone), else a reply running here
    // stops, else an empty composer closes the panel — from anywhere in the
    // panel (the conversation, a header button), not only from the box, as
    // helpDoc promises. Whatever else consumes Escape first (an edit box, the
    // rename field) prevents it; another field holding the keyboard is left be.
    const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
        if (e.key !== 'Escape' || e.defaultPrevented || e.nativeEvent.isComposing) return;
        if (document.querySelector('.agent-panel-layer .agent-popover')) return;
        if (runHere) {
            // A second press while it is stopping is the same request, not a
            // licence to close the panel under it.
            e.preventDefault();
            if (run?.phase !== 'stopping') stop();
            return;
        }
        const target = e.target as HTMLElement;
        const field = composerField();
        if (target !== field && target.closest('input, textarea, select, [contenteditable="true"]')) return;
        if (field?.value) return;
        e.preventDefault();
        onClose();
    };

    const notify = (message: string) => host.notify(message);
    const title = chatUi ? <TitleMenu chat={active} running={runHere} theme={theme} notify={notify} /> : <div className="agent-title is-static"><span className="agent-title-text">{HELPER_NAME}</span></div>;

    return (
        <div
            ref={rootRef}
            className={'agent-panel' + (chatUi && empty ? ' is-empty' : '')}
            data-agent-panel=""
            data-theme={theme}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onContextMenu={onContextMenu}
            onKeyDown={onKeyDown}
        >
            <header className="agent-header">
                {title}
                {chatUi && <ChatList state={state} theme={theme} notify={notify} />}
                {/* Kept in place while the connection comes back, greyed and
                    saying why: it went and came with each redial, and the
                    buttons beside it moved under the pointer. */}
                {chatUi && !empty && (
                    <IconButton
                        label="New chat"
                        tooltip={ready ? undefined : updating ? 'Wait for the update to finish' : `Wait for ${HELPER_NAME} to ${reconnecting ? 'reconnect' : 'connect'}`}
                        aria-disabled={ready ? undefined : true}
                        onClick={ready ? newChat : undefined}
                    >
                        <SquarePen />
                    </IconButton>
                )}
                <MoreMenu
                    state={state}
                    bridge={bridge}
                    theme={theme}
                    ready={ready}
                    supported={supported}
                    os={os}
                    arch={arch}
                    onReconnect={connect}
                    onUpdate={update}
                    onUninstall={() => void uninstall()}
                />
                <IconButton label="Close the agent panel" tooltip="Close (⌘⇧X)" onClick={onClose}>
                    <X />
                </IconButton>
            </header>

            {ready && <UpdateBar helper={bridge.helper} update={bridge.update} os={os} arch={arch} onUpdate={update} />}
            {updating && <UpdateProgress bridge={updating} />}
            {panelError && <div className="agent-strip is-error" role="alert">{panelError}</div>}
            {connecting && (
                <div className={'agent-connecting va-col' + (reconnecting ? ' is-reconnecting' : '')} role="status">
                    <Shimmer>{reconnecting ? 'Reconnecting' : 'Connecting'} to {HELPER_NAME}…</Shimmer>
                    {/* For the whole episode, dialling or waiting: the bridge
                        flips between the two every few seconds, and a button
                        that came and went with it could not be clicked. */}
                    {reconnecting && <button type="button" className="agent-text-btn" onClick={connect}>Retry now</button>}
                </div>
            )}

            {chatUi ? (
                <div className="agent-body">
                    {empty ? <Greeting vaultName={vault ? vaultName : null} note={note} /> : (
                        <MessageList
                            conversation={conversation}
                            run={run}
                            runHere={runHere}
                            theme={theme}
                            host={host}
                            onRetryHistory={() => { if (active) void chatStore.loadHistory(active); }}
                        />
                    )}
                    <div ref={footerRef} className="agent-footer">
                        <Composer
                            theme={theme}
                            draftKey={key}
                            blockedReason={inert ? null : composer.blocked}
                            inert={inert}
                            placeholder={empty ? 'How can I help with your notes?' : `Reply to ${HELPER_NAME}…`}
                            caption={composer.caption}
                            captionTone={composer.tone}
                            running={runHere}
                            stopping={runHere && run?.phase === 'stopping'}
                            imagesAllowed={model ? model.images : true}
                            dropping={dragging}
                            canEditLast={!empty && !run}
                            tools={<ToolsMenu state={state} theme={theme} disabled={inert || !!composer.blocked} />}
                            model={<ModelPicker state={state} theme={theme} disabled={inert || (!!composer.blocked && !runHere)} />}
                            onSend={send}
                            onStop={stop}
                            registerDrop={registerDrop}
                            registerFill={registerFill}
                        />
                    </div>
                    {empty && <Suggestions note={note} disabled={inert || !!composer.blocked} onFill={text => fillHandler.current?.(text)} />}
                </div>
            ) : (
                <div className="agent-setup">
                    <SetupGuide supported={supported} bridge={bridge} agents={state.agents} os={os} arch={arch} onConnect={connectFromGate} onUpdate={update} />
                </div>
            )}
        </div>
    );
}

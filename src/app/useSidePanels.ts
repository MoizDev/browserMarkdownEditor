import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { connectHelperForTerminal } from '../components/terminalLaunch';
import { scheduleAgentUpdateCheck } from '../components/agentUpdateHint';
import { readStoredValue, writeStoredValue } from '../utils/storage';
import type { FileSystemContextValue } from '../types';

/** The agent panel's width: at least 300px (its composer and header need it),
 *  at most half the window (the editor keeps the other half), 400 by default. */
const AGENT_PANEL_MIN = 300;
function clampAgentWidth(width: number): number {
  const max = Math.max(AGENT_PANEL_MIN, Math.floor(window.innerWidth / 2));
  return Number.isFinite(width) ? Math.min(max, Math.max(AGENT_PANEL_MIN, Math.round(width))) : 400;
}

/** What the side-panels hook reads from App. */
export interface UseSidePanelsDeps {
  rootHandleRef: React.RefObject<FileSystemContextValue['rootHandle']>;
}

export function useSidePanels(deps: UseSidePanelsDeps) {
  const { rootHandleRef } = deps;

  // The AI agent panel, docked on the right (⌘⇧X, or the sidebar footer's
  // sparkles). Width and open state persist like the sidebar's; the width is
  // clamped on read and on every drag, since localStorage is user-editable and
  // a window can shrink under a stored width.
  const [agentPanelOpen, setAgentPanelOpen] = useState<boolean>(() => readStoredValue('agentPanelOpen') === 'true');
  useEffect(() => {
    writeStoredValue('agentPanelOpen', String(agentPanelOpen));
  }, [agentPanelOpen]);
  const [agentPanelWidth, setAgentPanelWidth] = useState<number>(() => clampAgentWidth(parseInt(readStoredValue('agentPanelWidth') || '', 10)));
  // Whether the reader has opened the panel this session (⌘⇧X, the footer
  // button), as against it being restored open with the page: only an open
  // they asked for takes the keyboard (AgentPanel's focus hand-off). What was
  // focused cannot tell them apart — a note in Reading mode leaves <body>
  // focused either way.
  const [agentOpenedByReader, setAgentOpenedByReader] = useState(false);
  const toggleAgentPanel = useCallback(() => {
    setAgentOpenedByReader(true);
    setAgentPanelOpen(o => !o);
  }, []);
  const closeAgentPanel = useCallback(() => setAgentPanelOpen(false), []);

  // The terminal (⌃`, or the footer button beside the agent's), docked under
  // the editor. Open state persists like the agent panel's; its height is the
  // dock's own (TerminalDock). Only an open the reader asked for takes the
  // keyboard, as with the agent panel.
  const [terminalOpen, setTerminalOpen] = useState<boolean>(() => readStoredValue('terminalOpen') === 'true');
  useEffect(() => {
    writeStoredValue('terminalOpen', String(terminalOpen));
  }, [terminalOpen]);
  const [terminalOpenedByUser, setTerminalOpenedByUser] = useState(false);
  const terminalOpenRef = useRef(terminalOpen);
  useEffect(() => { terminalOpenRef.current = terminalOpen; }, [terminalOpen]);
  /** Stable: SidebarFooter is memoized. Opening dials the helper from INSIDE
   *  the gesture — the one moment Chrome's Local Network Access prompt may
   *  appear — never on page load (connectHelperForTerminal keeps that rule). */
  const toggleTerminal = useCallback(() => {
    setTerminalOpenedByUser(true);
    if (!terminalOpenRef.current) connectHelperForTerminal();
    setTerminalOpen(o => !o);
  }, []);
  const hideTerminal = useCallback(() => setTerminalOpen(false), []);
  // Each load asks the helper (if one was ever connected) whether VaultAgent has
  // a newer release, so the sidebar can say so before the panel is opened.
  useEffect(() => { scheduleAgentUpdateCheck(); }, []);

  // ⌘⇧X — the AI agent panel. Chosen because nothing else claims it: ⌘⇧K is
  // CodeMirror's deleteLine, ⌘⇧L/⌘⇧U/⌘⇧\ are CodeMirror's,
  // ⌘⇧A/B/C/D/H/I/J/M/N/O/R/T/W are Chrome's, ⌘⇧E/P/S/Y/. are Edge's. In the CAPTURE phase so a focused editor or canvas never sees it.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey || e.key.toLowerCase() !== 'x') return;
      if (!rootHandleRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      setAgentOpenedByReader(true);
      setAgentPanelOpen(o => !o);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [rootHandleRef]);

  // ⌃` — the terminal, on every OS: VS Code's chord, and the one its users'
  // fingers already know. ⌃ rather than ⌘ even on a Mac (⌘` is the OS's own
  // window cycling). Capture phase like ⌘⇧X, so it also closes the dock from
  // inside the shell, as in VS Code — xterm would otherwise send it as NUL.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.code !== 'Backquote') return;
      if (!rootHandleRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      toggleTerminal();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [toggleTerminal, rootHandleRef]);

  // Drag-to-resize the agent panel: the handle sits on its LEFT edge, so the
  // width is the distance from the pointer to the window's right edge.
  const startAgentResize = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    let width = clampAgentWidth(window.innerWidth - e.clientX);

    const onMouseMove = (ev: MouseEvent) => {
      width = clampAgentWidth(window.innerWidth - ev.clientX);
      setAgentPanelWidth(width);
    };
    const onMouseUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Once, at the end of the drag — not sixty writes a second.
      writeStoredValue('agentPanelWidth', String(width));
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  return {
    agentPanelOpen, agentPanelWidth,
    agentOpenedByReader,
    toggleAgentPanel,
    closeAgentPanel,
    startAgentResize,
    terminalOpen,
    terminalOpenedByUser,
    toggleTerminal,
    hideTerminal,
  };
}

import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { connectHelperForTerminal } from '../components/terminalLaunch';
import { scheduleAgentUpdateCheck } from '../components/agentUpdateHint';
import { readStoredValue, writeStoredValue } from '../utils/storage';
import type { FileSystemContextValue } from '../types';

const AGENT_PANEL_MIN = 300;
function clampAgentWidth(width: number): number {
  const max = Math.max(AGENT_PANEL_MIN, Math.floor(window.innerWidth / 2));
  return Number.isFinite(width) ? Math.min(max, Math.max(AGENT_PANEL_MIN, Math.round(width))) : 400;
}

export interface UseSidePanelsDeps {
  rootHandleRef: React.RefObject<FileSystemContextValue['rootHandle']>;
}

export function useSidePanels(deps: UseSidePanelsDeps) {
  const { rootHandleRef } = deps;

  const [agentPanelOpen, setAgentPanelOpen] = useState<boolean>(() => readStoredValue('agentPanelOpen') === 'true');
  useEffect(() => {
    writeStoredValue('agentPanelOpen', String(agentPanelOpen));
  }, [agentPanelOpen]);
  const [agentPanelWidth, setAgentPanelWidth] = useState<number>(() => clampAgentWidth(parseInt(readStoredValue('agentPanelWidth') || '', 10)));
  const [agentOpenedByReader, setAgentOpenedByReader] = useState(false);
  const toggleAgentPanel = useCallback(() => {
    setAgentOpenedByReader(true);
    setAgentPanelOpen(o => !o);
  }, []);
  const closeAgentPanel = useCallback(() => setAgentPanelOpen(false), []);

  const [terminalOpen, setTerminalOpen] = useState<boolean>(() => readStoredValue('terminalOpen') === 'true');
  useEffect(() => {
    writeStoredValue('terminalOpen', String(terminalOpen));
  }, [terminalOpen]);
  const [terminalOpenedByUser, setTerminalOpenedByUser] = useState(false);
  const terminalOpenRef = useRef(terminalOpen);
  useEffect(() => { terminalOpenRef.current = terminalOpen; }, [terminalOpen]);
  const toggleTerminal = useCallback(() => {
    setTerminalOpenedByUser(true);
    if (!terminalOpenRef.current) connectHelperForTerminal();
    setTerminalOpen(o => !o);
  }, []);
  const hideTerminal = useCallback(() => setTerminalOpen(false), []);
  useEffect(() => { scheduleAgentUpdateCheck(); }, []);

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

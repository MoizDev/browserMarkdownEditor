// Kept import-free of the renderer: both callers share this tiny terminal-reservation signal.
export { getTerminalContextActive, setTerminalContextActive, subscribeTerminalContext } from '../platform/terminalContext';

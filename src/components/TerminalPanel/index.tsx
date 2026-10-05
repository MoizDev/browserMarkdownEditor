// The terminal's lazy entry point: TerminalDock does
//   const TerminalPanel = React.lazy(() => import('./TerminalPanel'));
// so everything below — xterm and its addons, the stylesheets (imported HERE and
// not from index.css) and the font's @font-face — lands in its own chunk, and a
// user who never opens the terminal downloads none of it. Nothing outside this
// folder may import xterm, and components/prefetchPanes.ts must never warm it.

import '@xterm/xterm/css/xterm.css';
import './TerminalPanel.css';
import './terminalFont.css';

export { default } from './TerminalPanel';

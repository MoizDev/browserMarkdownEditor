// The panel's lazy entry point: App does
//   const AgentPanel = React.lazy(() => import('./components/AgentPanel'));
// so everything below — the stylesheets included, which is why they are
// imported HERE and not from index.css — lands in its own chunk, and a user
// who never opens the panel downloads none of it.

import './aicss/aicss.css';
import './AgentPanel.css';

export { default } from './AgentPanel';

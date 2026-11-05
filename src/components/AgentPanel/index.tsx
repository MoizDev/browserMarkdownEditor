// The panel's lazy entry point: App does
//   const AgentPanel = React.lazy(() => import('./components/AgentPanel'));
// so everything below — the stylesheets and the reply face's font files
// included, which is why they are imported HERE and not from index.css —
// lands in its own chunk, and a user who never opens the panel downloads none
// of it.
//
// The order is the cascade's: tokens first (every later file reads them), then
// the frame, then each region, then the panel-scoped overrides of the shared
// setup gate. Equal-specificity rules in a later file win, so keep it.

import './aicss/aicss.css';
import './styles/tokens.css';
import './styles/frame.css';
import './styles/header.css';
import './styles/conversation.css';
import './styles/composer.css';
import './styles/popovers.css';
import './styles/gate.css';
import { applyAgentReplyFont } from '../../utils/agentReplyFont';
import { applyAgentTextSize } from '../../utils/agentTextSize';

// Settings → Agent replies and Agent text size live on <html> (tokens.css
// reads them); nothing in the main chunk applies them, since only this
// chunk's CSS looks.
applyAgentReplyFont();
applyAgentTextSize();

export { default } from './AgentPanel';

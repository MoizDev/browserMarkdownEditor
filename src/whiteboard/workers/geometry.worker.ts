import { serve } from '../../platform/workers';
import { boardHandlers } from './protocol';

// Geometry operations are registered here as their bounded slab implementations land.
serve({ protocol: 1, buildId: 'whiteboard-geometry-1', handlers: boardHandlers({}) });

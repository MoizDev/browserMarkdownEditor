import type { ActiveFile } from '../types';
import { isCanvasFile } from '../utils/fileTypes';
import { isTextFile } from '../utils/vaultSearch';

/**
 * Whether a document's text can embed a picture — i.e. whether its `.Assets`
 * folder has to be kept in step with it. A drawing and a PDF are text on disk
 * but a canvas on screen, and the Help guide has no folder of its own.
 */
export function tracksAssets(file: ActiveFile): boolean {
  return !file.isHelp && !!file.parentHandle && isTextFile(file.name) && !isCanvasFile(file.name);
}

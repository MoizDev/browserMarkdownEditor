import type { ActiveFile } from '../types';
import { isCanvasFile } from '../utils/fileTypes';
import { isTextFile } from '../utils/vaultSearch';

export function tracksAssets(file: ActiveFile): boolean {
  return !file.isHelp && !!file.parentHandle && isTextFile(file.name) && !isCanvasFile(file.name);
}

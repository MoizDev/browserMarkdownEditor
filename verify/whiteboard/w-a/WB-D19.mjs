import { hosts } from './lib/files.mjs';
import { saveDelay } from './lib/save-delay.mjs';
for (const host of hosts) for (const exit of ['close-tab', 'reload']) {
  for (const cmdS of [false, true]) await saveDelay('WB-D19', host, { exit, cmdS });
}

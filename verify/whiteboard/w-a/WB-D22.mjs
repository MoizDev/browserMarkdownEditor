import { hosts } from './lib/files.mjs';
import { saveDelay } from './lib/save-delay.mjs';
for (const host of hosts) for (const milliseconds of [0, 4, 16]) {
  await saveDelay('WB-D22', host, { milliseconds });
}

// Outside-only reconnaissance of the real reference app's DOM and network metadata.
import { mkdir, writeFile } from 'node:fs/promises';
import { launchRuntime, frames } from '../harness/runtime.mjs';
import { vaultHelpers } from '../harness/vault.mjs';
const out = '/Users/adham/Developer/bme-impl/scratch/w-b/b39/discovery';
await mkdir(out, { recursive: true });
const h = await launchRuntime({ baseURL: process.env.BASE_URL || 'http://localhost:6520/', blockOffOrigin: true });
const result = { runtime: h.runtimeIdentity, markers: [], controls: [], errors: h.errors };
try {
  const vault = vaultHelpers(h);
  await vault.seed({ 'Seed.md': '# Reference marker discovery\n' });
  await vault.open();
  await h.page.locator('[data-tooltip="New drawing or notebook"]').click();
  await h.page.getByRole('menuitem', { name: 'New Drawing', exact: true }).click();
  await h.page.locator('input:focus').fill('Observe.tldraw');
  await h.page.locator('input:focus').press('Enter');
  await h.page.locator('.tl-container').waitFor();
  await frames(h.page, 3);
  for (const [url, response] of h.responseObjects) {
    if (response.request().resourceType() !== 'script') continue;
    const text = await response.text();
    const markers = [...text.matchAll(/["']@tldraw\/[^"']+["']/g)].map(match => text.slice(Math.max(0, match.index - 25), match.index + match[0].length + 65));
    if (markers.length) result.markers.push({ url, markers });
  }
  result.controls = await h.page.locator('.tl-container button').evaluateAll(buttons => buttons.map(button => ({ text: button.textContent, label: button.getAttribute('aria-label'), tooltip: button.getAttribute('data-tooltip'), testid: button.getAttribute('data-testid'), state: button.getAttribute('data-state'), pressed: button.getAttribute('aria-pressed'), classes: button.className })).filter(button => button.testid || /select|draw|pen|undo|redo|tool/i.test(button.label || '')));
  await h.page.screenshot({ path: `${out}/toolbar.png` });
} finally {
  await writeFile(`${out}/observations.json`, JSON.stringify(result, null, 2) + '\n');
  await h.close();
}
console.log(JSON.stringify(result, null, 2));

import assert from 'node:assert/strict';
import { runArm, frames } from './lib/browser.mjs';
import { setup, saved, waitStrokes } from './lib/files.mjs';

for (const host of ['notebook', 'pdf']) await runArm('WB-D33', `${host}-keyboard-backdrop`, async h => {
  const name = await setup(h, host);
  await h.draw(.3, .3); await waitStrokes(h, name, 1);
  const initial = await saved(h, name, 'initial');
  assert.equal(initial.backdrops.length, 1, 'Single locked page fixture required');
  await h.canvas().focus(); await h.chord('v'); await h.chord('Escape');
  const navigation = [];
  let reached = false;
  for (let i = 0; i < 5; i++) {
    await h.chord('Tab'); await frames(h.page, 7);
    const status = await h.page.getByRole('status', { name: 'Status', exact: true }).innerText();
    navigation.push({ step: i + 1, status, aria: await h.canvas().ariaSnapshot(), capture: await h.capture(`tab-${i + 1}`) });
    if (/image|locked|paper/i.test(status)) { reached = true; break; }
  }
  // No private selection is read. If today's public status does not identify the
  // locked page, keep the observations but do not pretend the keyboard arm ran.
  if (!reached) return { status: 'pending-B39-or-public-selection-witness', reproduced: null,
    witness: { publicBackdropSelection: false }, navigation,
    loss: 'The public status did not identify the selected backdrop. Private-probe results cannot count until w-b B-39 and same-run controls are reviewed.' };
  const actions = [];
  for (const key of ['Delete', 'ArrowRight', 'ArrowDown', 'Backspace']) {
    const before = await saved(h, name), marker = await h.mark();
    await h.chord(key); await h.page.waitForTimeout(2500);
    const after = await saved(h, name, `after-${key}`);
    actions.push({ key, bytesChanged: before.sha256 !== after.sha256,
      backdropChanged: JSON.stringify(before.backdrops) !== JSON.stringify(after.backdrops),
      completedWrites: (await h.writes(name)).filter(w => w.id > marker && w.closed !== null).length });
  }
  return { status: 'observed', witness: { publicBackdropSelection: true,
    damagingActions: actions.filter(a => a.backdropChanged).length,
    completedWrites: actions.reduce((n, a) => n + a.completedWrites, 0) },
    reproduced: false, navigation, actions, capture: await h.capture('after-keys'),
    loss: 'This is the already-safe locked-backdrop keyboard control, not WB-D33 camera-reveal repair. It uses the public status and subsequent real key effects; no private selection equality is inferred.' };
});

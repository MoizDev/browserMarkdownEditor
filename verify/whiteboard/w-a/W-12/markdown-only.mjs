import assert from 'node:assert/strict';
import { runArm, frames } from '../lib/browser.mjs';
import { observeWindowTouchListeners, windowTouchState } from './window-touch.mjs';

let rejected = false;
try {
await runArm('W-12-lazy', 'markdown-only', async h => {
  const note = '# Markdown-only pen control\n\nNo canvas file is in this vault.';
  await h.seed({ 'Seed.md': note }); await h.openVault(); await h.open('Seed.md');
  const editor = h.page.locator('.cm-content:visible'); await editor.waitFor(); await frames(h.page, 4);
  const idleRegistrations = await windowTouchState(h.page);
  const idleBlocking = idleRegistrations.appActive.filter(e => e.passive === false);
  assert.equal(idleBlocking.length, 0, 'W12-TOUCH-IDLE: idle window has non-passive touch listeners');
  await h.page.evaluate(() => {
    window.__w12MarkdownTouches = [];
    for (const type of ['pointerdown', 'touchstart']) window.addEventListener(type, e => {
      if (e.pointerType === 'touch' || e.type === 'touchstart') window.__w12MarkdownTouches.push({ type, trusted: e.isTrusted });
    }, { capture: true, passive: true });
  });
  const box = await editor.boundingBox(), a = { x: box.x + 100, y: box.y + 20 };
  await h.pointer('mouseMoved', a, { buttons: 0 }); await h.pointer('mousePressed', a);
  const contacts = [{ x: a.x + 100, y: a.y + 60 }, { x: a.x + 160, y: a.y + 60 }];
  await h.touch('touchStart', contacts); await h.touch('touchEnd', []);
  await h.pointer('mouseReleased', a); await frames(h.page, 4);
  const touches = await h.page.evaluate(() => window.__w12MarkdownTouches);
  assert(touches.some(e => e.trusted && e.type === 'pointerdown') && touches.some(e => e.trusted && e.type === 'touchstart'),
    'A pen outside a legacy pane must not make the filter swallow following touches');
  assert.equal(await h.page.locator('[data-legacy-board]').count(), 0, 'No legacy surface is allowed in this arm');
  assert.equal((await h.read('Seed.md')).toString(), note, 'Display-only pen/touch input changed the note');
  assert.equal((await h.writes('Seed.md')).length, 0, 'Display-only pen/touch input wrote the note');
  const afterRegistrations = await windowTouchState(h.page);
  await h.artifact('window-touch-registrations.json', JSON.stringify({ idleRegistrations, afterRegistrations }, null, 2));
  assert.equal(afterRegistrations.appActive.filter(e => e.passive === false).length, 0,
    'W12-TOUCH-IDLE: a pen outside legacy panes armed non-passive touch listeners');
  return { passed: true, witness: { outsidePenTouchesDelivered: touches.length, legacyRoots: 0, noteWrites: 0,
    idleNonPassiveWindowTouchListeners: idleBlocking.length },
    idleRegistrations, afterRegistrations, touches, capture: await h.capture('markdown-only'),
    loss: 'Shows no canvas module/resource load and no touch suppression outside a legacy pane; it is not a timing benchmark of the constant-time listener fast path.' };
}, { hasTouch: true, legacyCanvas: false, init: observeWindowTouchListeners });
} catch (error) {
  if (process.env.EXPECT_FAILURE === 'canvas-loaded'
    && /A Markdown-only session loaded (a canvas engine chunk|the canvas library)/.test(error.message)) rejected = true;
  else if (process.env.EXPECT_FAILURE === 'touch-listeners-when-idle' && error.message.startsWith('W12-TOUCH-IDLE:')) rejected = true;
  else throw error;
}
if (process.env.EXPECT_FAILURE) {
  assert(rejected, `Mutant did not trip the named guard ${process.env.EXPECT_FAILURE}`);
  console.log(`MUTANT REJECTED by ${process.env.EXPECT_FAILURE}`);
}

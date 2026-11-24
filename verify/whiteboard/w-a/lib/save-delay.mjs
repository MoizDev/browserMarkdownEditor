import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { runArm, delay } from './browser.mjs';
import { setup, waitStrokes, saved, document, shapePaint } from './files.mjs';

export async function saveDelay(row, host, { milliseconds = 0, exit = null, cmdS = true } = {}) {
  return runArm(row, `${host}-${exit ?? 'save'}-${milliseconds}ms-${cmdS ? 'cmdS' : 'no-cmdS'}`, async h => {
    const name = await setup(h, host);
    await h.draw(.3, .3); await waitStrokes(h, name, 1);
    const before = await saved(h, name, 'baseline');
    const mark = await h.mark();
    await h.draw(.5, .5, { wait: 0 });
    const released = performance.now();
    if (milliseconds) await delay(milliseconds);
    if (cmdS) await h.chord('Mod+s');
    const commandElapsed = performance.now() - released;
    const strokeOnScreen = (await shapePaint(h)).filter(s => s.type === 'draw').length;
    assert.equal(strokeOnScreen, 2, 'Actual second stroke was not painted');
    if (exit === 'close-tab') await h.closeTab(name);
    else if (exit === 'reload') {
      await h.page.evaluate(() => { window.__waReloadMarker = true; });
      h.page.once('dialog', async dialog => {
        assert.equal(dialog.type(), 'beforeunload', 'Unexpected native dialog during real reload');
        await dialog.accept();
      });
      await h.page.reload();
      assert.equal(await h.page.evaluate(() => Boolean(window.__waReloadMarker)), false, 'Hash-only navigation is not a reload');
      await h.page.locator('.vault-switcher').waitFor();
    }
    if (cmdS && !exit) await h.waitWrite(name, mark);
    await delay(exit ? 2500 : 100);
    const writes = (await h.writes(name)).filter(w => w.id > mark);
    const first = writes.find(w => w.closed !== null && w.bytes);
    const firstContent = first ? await document(Buffer.from(first.bytes), name) : null;
    const after = await saved(h, name, 'after-barrier');
    let later = null;
    if (!exit) { await waitStrokes(h, name, 2); later = await saved(h, name, 'later-autosave'); }
    return { requestedDelayMs: milliseconds, actualCmdSAfterReleaseMs: cmdS ? commandElapsed : null,
      exit, cmdS, witness: { baselineStrokes: before.strokes.length, secondStrokePainted: strokeOnScreen,
        firstCompletedWriteStrokes: firstContent?.strokes?.length ?? null, afterBarrierStrokes: after.strokes.length,
        laterAutosaveStrokes: later?.strokes.length ?? null },
      reproduced: exit ? after.strokes.length < 2 : firstContent?.strokes?.length < 2,
      before, after, later, firstWrite: first ? { id: first.id, start: first.start, closed: first.closed } : null,
      capture: await h.capture('after-barrier'),
      loss: 'Driver round trips mean requested 0/4/16 ms are minimum delays, not exact hardware chord times; actual elapsed is recorded. Reload uses real native IndexedDB on pinned Chrome. Window-close, pane-close, vault-switch and folder-trash are separate future gate arms.' };
  }, { captureWrites: true });
}

/** Font requests finishing is not the same as font layout finishing.
 * @param {import('playwright').Page} page
 */
export async function fontsReady(page) {
    await page.evaluate(async () => { await document.fonts.ready; });
}

/** Files open in read mode: use the user's shortcut, never flip editor internals.
 * @param {import('playwright').Page} page
 */
export async function editMode(page) {
    const editor = page.locator('.cm-content:visible');
    await editor.waitFor();
    if (await editor.getAttribute('contenteditable') !== 'true') await page.keyboard.press('ControlOrMeta+e');
    await page.waitForFunction(() => [...document.querySelectorAll('.cm-content')].some(el => el.getAttribute('contenteditable') === 'true' && el.getClientRects().length));
}

export async function typeText(page, text) { await page.keyboard.insertText(text); }
export async function press(page, key) { await page.keyboard.press(key); }
export async function pointer(page, { x, y, button = 'left' }) { await page.mouse.click(x, y, { button }); }
export async function wheel(page, { x = 0, y }) { await page.mouse.wheel(x, y); }

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runArm } from './lib/browser.mjs';
import { setup, seedPdf, waitStrokes, saved, exportNotebook, shapePaint } from './lib/files.mjs';
import { download, pixels, inkRegions, readerCapture } from './lib/output.mjs';

function storedDark() {
  localStorage.setItem('theme', 'light');
  localStorage.setItem('TLDRAW_USER_DATA_v3', JSON.stringify({ version: 13,
    user: { id: 'W00OriginalPreference', color: '#55B467', colorScheme: 'dark' } }));
}
for (const host of ['notebook', 'pdf']) await runArm('WB-D28', `${host}-stored-dark`, async h => {
  const name = await setup(h, host, { 'PrintedOutput.pdf': await seedPdf() });
  await h.draw(.35, .4); await waitStrokes(h, name, 1);
  const paint = await shapePaint(h), ink = paint.find(s => s.type === 'draw');
  assert(ink?.colors.length, 'Actual visible ink paths missing');
  const regions = await inkRegions(h), savedFile = await saved(h, name, 'dark-semantic-ink');
  assert.equal(savedFile.strokes[0].props.color, 'black', 'Named black ink fixture required');
  const screenBytes = await h.page.locator('.tl-container:visible .tl-shape[data-shape-type="draw"]').first().screenshot();
  await h.artifact('screen-ink.png', screenBytes);
  const screenStats = (await pixels(h, screenBytes))[0];
  const png = await download(h, 'png', 'generic-dark'), svg = await download(h, 'svg', 'generic-dark');
  const svgBytes = await fs.readFile(path.join(h.output, svg));
  const pngStats = await pixels(h, await fs.readFile(path.join(h.output, png)), regions);
  const colors = [...new Set(svgBytes.toString().match(/#[0-9a-fA-F]{6}/g) ?? [])];
  let output;
  if (host === 'notebook') { await exportNotebook(h); output = await h.read(name.replace(/\.notebook$/, '.pdf')); }
  else output = await h.read(name);
  await h.artifact('printed-output.pdf', output);
  await h.page.getByRole('button', { name: 'Menu', exact: true }).click();
  await h.page.getByRole('menuitem', { name: 'Preferences', exact: true }).hover();
  await h.page.waitForTimeout(400);
  const themeControlVisible = await h.page.getByRole('menuitem', { name: 'Theme', exact: true }).isVisible();
  if (themeControlVisible) {
    await h.page.getByRole('menuitem', { name: 'Theme', exact: true }).hover();
    await h.page.waitForTimeout(400);
  }
  const menuCapture = await h.capture('paper-theme-control'); await h.chord('Escape'); await h.chord('Escape');
  const stored = await h.page.evaluate(() => localStorage.getItem('TLDRAW_USER_DATA_v3'));
  await h.seed({ 'PrintedOutput.pdf': output });
  const pdfOutput = await readerCapture(h, 'PrintedOutput.pdf', regions, 'printed-reader');
  assert(pdfOutput.regions[0].darkPixels > 20, 'Printed PDF control contains no dark ink');
  return { fixture: { source: 'original nondefault TLDRAW_USER_DATA_v3 record seeded before app loads', colorScheme: 'dark' },
    witness: { namedInk: 'black', screenDarkPixels: screenStats.darkPixels,
      screenNearWhitePixels: screenStats.nearWhitePixels, svgContainsNearWhite: colors.includes('#f2f2f2'),
      genericPngRoiDarkPixels: pngStats[0].darkPixels, printedPdfDarkPixels: pdfOutput.regions[0].darkPixels,
      themeControlVisible },
    reproduced: ink.colors.some(c => /242, 242, 242|#f2f2f2/.test(c.fill + c.stroke)),
    paint, savedFile, screenStats, pngStats, svgColors: colors, stored, pdfOutput, captures: [menuCapture],
    loss: 'Generic PNG uses the normalized screen ink ROI, whose padding can differ in the download; retained PNG/SVG bytes are the stronger inspection artifacts. PDF printing is checked through the real app reader, not an engine-private export.' };
}, { init: storedDark });

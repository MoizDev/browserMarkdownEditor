import assert from 'node:assert/strict';
import { frames } from './browser.mjs';
import { shapePaint } from './files.mjs';

export async function inkRegions(h) {
  const shapes = await shapePaint(h);
  const paper = shapes.find(s => s.type === 'image');
  assert(paper?.rect.width && paper.rect.height, 'Painted paper bounds missing');
  return shapes.filter(s => s.type === 'draw').map(stroke => ({ id: stroke.id,
    x: (stroke.rect.x - paper.rect.x) / paper.rect.width,
    y: (stroke.rect.y - paper.rect.y) / paper.rect.height,
    width: stroke.rect.width / paper.rect.width, height: stroke.rect.height / paper.rect.height }));
}
export async function pixels(h, bytes, regions = [{ x: 0, y: 0, width: 1, height: 1 }]) {
  return h.page.evaluate(async ({ base64, regions }) => {
    const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    return regions.map(region => {
      const x = Math.max(0, Math.floor(region.x * canvas.width)), y = Math.max(0, Math.floor(region.y * canvas.height));
      const width = Math.min(canvas.width - x, Math.ceil(region.width * canvas.width));
      const height = Math.min(canvas.height - y, Math.ceil(region.height * canvas.height));
      if (width <= 0 || height <= 0) throw Error('Ink ROI outside output');
      const { data } = ctx.getImageData(x, y, width, height);
      let dark = 0, nearWhite = 0, min = 255;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue;
        const c = [data[i], data[i + 1], data[i + 2]]; min = Math.min(min, ...c);
        if (Math.max(...c) < 128) dark++;
        if (Math.min(...c) >= 235 && Math.max(...c) < 250 && Math.max(...c) - Math.min(...c) < 4) nearWhite++;
      }
      return { region, x, y, width, height, darkPixels: dark, nearWhitePixels: nearWhite, minChannel: min };
    });
  }, { base64: bytes.toString('base64'), regions });
}
export async function readerCapture(h, name, regions, label) {
  await h.open(name);
  const canvas = h.page.locator('.pdf-viewer:visible .pdf-viewer-page canvas').first();
  await canvas.waitFor();
  await h.page.waitForFunction(() => {
    const c = document.querySelector('.pdf-pane:not(.pdf-pane-hidden) .pdf-viewer-page canvas');
    return c && c.width > 0 && c.height > 0;
  });
  await frames(h.page, 11);
  const bytes = await canvas.screenshot(); await h.artifact(`${label}.png`, bytes);
  return { capture: `${label}.png`, regions: await pixels(h, bytes, regions) };
}
export async function download(h, format, label) {
  await h.chord('Escape'); await h.chord('Escape');
  await h.page.getByRole('button', { name: 'Menu', exact: true }).click();
  await h.page.getByRole('menuitem', { name: 'Export', exact: true }).click();
  const pending = h.page.waitForEvent('download');
  await h.page.getByRole('menuitem', { name: format.toUpperCase(), exact: true }).click();
  const received = await pending;
  const file = `${label}.${format}`; await received.saveAs(`${h.output}/${file}`);
  return file;
}

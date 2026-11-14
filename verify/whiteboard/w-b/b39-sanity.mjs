// One real-app sanity run of the reference reader; no mutant/reviewer proof work.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { launch, frames } from '../harness/index.mjs';
const { values } = parseArgs({ options: {
  url: { type: 'string', default: 'http://localhost:6520/' },
  out: { type: 'string', default: '/Users/adham/Developer/bme-impl/scratch/w-b/b39/sanity' },
} });
await mkdir(values.out, { recursive: true });
const h = await launch({ baseURL: values.url, blockOffOrigin: true });
const report = { package: 'W-B2', scope: 'charter §0 sanity: real selection/tool reads on all three hosts', runtime: h.runtimeIdentity, hosts: [], errors: h.errors };
const root = () => h.page.locator('.tl-container:visible');
const theme = async wanted => {
  const button = h.page.getByRole('button', { name: `Switch to ${wanted} mode`, exact: true });
  if (await button.count()) await button.click();
  await frames(h.page, 5);
};
try {
  await h.vault.seed({ 'Sanity.pdf': await h.pdf.seed() });
  await h.vault.open();
  for (const [kind, path] of [['drawing', 'Sanity.tldraw'], ['notebook', 'Sanity.notebook'], ['pdf', 'Sanity.pdf']]) {
    await theme('light');
    if (kind === 'drawing') await h.ui.createDrawing(path);
    else if (kind === 'notebook') await h.ui.createNotebook(path);
    else await h.ui.annotate(path);
    await root().getByTestId('tools.draw').click();
    await frames(h.page, 2);
    const drawing = await h.probe.session(path);
    assert.equal(drawing.currentTool, 'pen');
    assert.equal(await root().getByTestId('tools.draw').getAttribute('aria-pressed'), 'true');
    const rect = await root().boundingBox();
    const point = { x: rect.x + rect.width * .42, y: rect.y + rect.height * .34 };
    await h.input.stroke([point, { x: point.x + 35, y: point.y + 10 }, { x: point.x + 80, y: point.y + 35 }]);
    const nodes = await h.probe.today(path);
    assert.equal(nodes.length, 1);
    const id = nodes[0].id;
    await root().getByTestId('tools.select').click();
    await h.page.mouse.click(rect.x + rect.width * .8, rect.y + rect.height * .25);
    await h.input.chord('Escape');
    assert.deepEqual((await h.probe.session(path)).selection, []);
    await h.page.mouse.click(point.x + 35, point.y + 10);
    const selected = await h.probe.session(path);
    assert.equal(selected.currentTool, 'select');
    assert.deepEqual(selected.selection, [id]);
    await h.input.chord('Escape');
    const cleared = await h.probe.session(path);
    assert.deepEqual(cleared.selection, []);
    await h.page.screenshot({ path: resolve(values.out, `${kind}-light.png`) });
    await theme('dark');
    const dark = await h.probe.session(path);
    assert.equal(dark.currentTool, 'select');
    await h.page.screenshot({ path: resolve(values.out, `${kind}-dark.png`) });
    report.hosts.push({ kind, path, drawTool: drawing.currentTool, selectTool: selected.currentTool, paintedNode: id, selected: selected.selection, cleared: cleared.selection, darkTool: dark.currentTool, backdrops: cleared.backdrops.length });
  }
  assert.deepEqual(h.errors, []);
  report.pass = true;
} catch (error) {
  report.pass = false;
  report.fault = error.stack;
  await h.page.screenshot({ path: resolve(values.out, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  report.library = h.probeVersionAssertions;
  await writeFile(resolve(values.out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await h.close();
}
console.log(JSON.stringify(report, null, 2));

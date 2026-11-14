// Reference-only controls: every state change below is real UI/input, never an editor setter.
import { randomUUID } from 'node:crypto';
import { frames } from '../runtime.mjs';

const kindOf = path => /\.pdf$/i.test(path) ? 'pdf' : /\.notebook$/i.test(path) ? 'notebook' : 'drawing';
const canonical = value => JSON.stringify(value);
const fail = (field, message) => { throw Error(`PROBE_CONTROL_ASSERT ${field}: ${message}`); };
const requireValue = (field, actual, expected, stage) => {
  if (canonical(actual) !== canonical(expected)) fail(field, `${stage}: expected ${canonical(expected)}, observed ${canonical(actual)}`);
};
export const PERSISTED_FIELDS = ['id', 'kind', 'subkind', 'figure', 'title', 'parent', 'order', 'localPosition.x', 'localPosition.y', 'rotation', 'swatch', 'width', 'fill', 'dash', 'opacity', 'font', 'textSize', 'alignment', 'verticalAlignment', 'plainText', 'richMarks', 'richText', 'locked', 'crop', 'flipX', 'flipY', 'altText', 'inverted', 'url', 'autoWidth', 'metadata'];
const leaf = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
const valuesOf = (nodes, path) => nodes.map(node => leaf(node, path));
// A changed count/id must not masquerade as a changed scalar field. Only a
// change in the set of actual leaf values qualifies the A/B control for it.
const valueSet = values => [...new Set(values.map(value => canonical(value)))].sort();

export function fieldControls(h) {
  const runId = randomUUID();
  const journal = [];
  h.referenceControlJournal = journal;
  h.referenceControlAttempts = [];
  const add = (fields, kind, mode, observation) => {
    const row = { runId, fields, kind, mode, complete: true, observation };
    journal.push(row);
    return row;
  };
  const session = path => h.probe.session(path);
  const root = () => h.page.locator('.tl-container:visible');
  const tool = async (path, id, expected) => {
    const button = root().getByTestId(`tools.${id}`);
    if (await button.count() !== 1) fail('session.currentTool', `expected one visible ${id} control`);
    await button.click();
    await frames(h.page, 3);
    const snapshot = await session(path);
    const pressed = await button.getAttribute('aria-pressed');
    h.referenceControlAttempts.push({ runId, field: 'session.currentTool', path, action: `click ${id}`, observedTool: snapshot.currentTool, pressed });
    requireValue('session.currentTool', snapshot.currentTool, expected, `after ${id} click`);
    requireValue('session.currentTool', pressed, 'true', `${id} real toolbar state`);
    return { tool: snapshot.currentTool, pressed };
  };
  const requireCount = (field, actual, expected, stage) => requireValue(field, actual, expected, stage);
  return {
    journal,
    runId,
    require(fields, { kind, phase = 'after-action' } = {}) {
      if (!['drawing', 'notebook', 'pdf'].includes(kind) || !['after-action', 'persisted-only'].includes(phase)) fail('control scope', 'an explicit host kind and known phase are required');
      for (const field of fields) {
        const control = journal.find(row => row.runId === runId && row.complete && row.fields.includes(field) && (!kind || row.kind === kind) && (phase !== 'after-action' || row.mode === 'action'));
        if (!control) fail(field, `UNCONTROLLED in this run/kind/phase; it cannot count as a parity reference`);
      }
      return { runId, fields, kind, phase };
    },
    async runUI(path) {
      await h.ui.openFile(path);
      await h.probe.ready(path);
      const kind = kindOf(path);
      if (await root().count() !== 1) fail('path', 'expected one active canvas');
      const binding = await h.probe.binding(path);
      const selectBefore = await tool(path, 'select', 'select');
      const pen = await tool(path, 'draw', 'pen');
      const selectAfter = await tool(path, 'select', 'select');
      add(['session.currentTool'], kind, 'action', { selectBefore, pen, selectAfter });
      const rectangle = await root().boundingBox();
      if (!rectangle) fail('path', 'active canvas has no visible box');
      const a = { x: rectangle.x + rectangle.width * .42, y: rectangle.y + rectangle.height * .34 };
      const b = { x: a.x + 80, y: a.y + 35 };
      const blank = { x: rectangle.x + rectangle.width * .78, y: rectangle.y + rectangle.height * .25 };
      const initial = await h.probe.today(path);
      if (initial.length !== 0) fail('session.selection', 'UI control fixture must start without user nodes');
      const historyBefore = await session(path);
      const undoBefore = await root().getByTestId('quick-actions.undo').isEnabled();
      requireValue('session.canUndo', historyBefore.canUndo, undoBefore, 'initial public Undo control');
      await tool(path, 'draw', 'pen');
      await h.input.stroke([a, { x: a.x + 35, y: a.y + 10 }, b], { kind: 'mouse' });
      await tool(path, 'select', 'select');
      const nodes = await h.probe.today(path);
      requireCount('nodes.length', nodes.length, 1, 'one real stroke');
      const id = nodes[0].id;
      if (await root().locator(`[data-shape-id=${JSON.stringify(id)}]`).count() < 1) fail('nodes[].id', 'new private id has no painted DOM counterpart');
      await h.page.mouse.click(blank.x, blank.y);
      await h.input.chord('Escape');
      requireValue('session.selection', (await session(path)).selection, [], 'blank click and Escape');
      await h.page.mouse.click(a.x + 35, a.y + 10);
      const selected = (await session(path)).selection;
      requireValue('session.selection', selected, [id], 'click the painted stroke');
      await h.input.chord('Escape');
      const cleared = (await session(path)).selection;
      requireValue('session.selection', cleared, [], 'real Escape clears selection');
      add(['session.selection'], kind, 'action', { empty: [], selected, cleared, paintedId: id });
      const historyDrawn = await session(path);
      requireValue('session.canUndo', historyDrawn.canUndo, true, 'after new stroke');
      requireValue('session.canUndo', await root().getByTestId('quick-actions.undo').isEnabled(), true, 'public Undo enabled');
      // Measured: the first Undo restored selection and left one stroke.
      // Exhaust the bounded public history, rather than calling selection Undo
      // a failed document write or claiming a single click removed the ink.
      const undoSteps = [], redoSteps = [];
      for (let i = 0; i < 20 && await root().getByTestId('quick-actions.undo').isEnabled(); i++) {
        requireValue('session.canUndo', (await session(path)).canUndo, true, 'public Undo remains enabled');
        await root().getByTestId('quick-actions.undo').click();
        await frames(h.page, 3);
        undoSteps.push({ count: (await h.probe.today(path)).length, state: await session(path) });
      }
      const undone = await session(path);
      requireCount('nodes.length', (await h.probe.today(path)).length, 0, 'real Undo sequence removed the stroke');
      requireValue('session.canUndo', undone.canUndo, false, 'Undo restored empty fixture');
      requireValue('session.canRedo', undone.canRedo, true, 'real Undo enables Redo');
      requireValue('session.canRedo', await root().getByTestId('quick-actions.redo').isEnabled(), true, 'public Redo enabled');
      for (let i = 0; i < 20 && await root().getByTestId('quick-actions.redo').isEnabled(); i++) {
        requireValue('session.canRedo', (await session(path)).canRedo, true, 'public Redo remains enabled');
        await root().getByTestId('quick-actions.redo').click();
        await frames(h.page, 3);
        redoSteps.push({ count: (await h.probe.today(path)).length, state: await session(path) });
      }
      const redone = await session(path);
      requireCount('nodes.length', (await h.probe.today(path)).length, 1, 'real Redo sequence restored the stroke');
      requireValue('session.canUndo', redone.canUndo, true, 'Redo enables Undo');
      requireValue('session.canRedo', redone.canRedo, false, 'Redo consumes redo entries');
      add(['session.canUndo', 'session.canRedo', 'nodes.length'], kind, 'action', { before: { canUndo: historyBefore.canUndo, canRedo: historyBefore.canRedo }, drawn: { canUndo: historyDrawn.canUndo, canRedo: historyDrawn.canRedo }, undone: { canUndo: undone.canUndo, canRedo: undone.canRedo }, redone: { canUndo: redone.canUndo, canRedo: redone.canRedo }, undoSteps, redoSteps });
      // These controls show raw observation responsiveness; exact paged camera
      // coordinates still have no cross-engine read-out (the mapping says so).
      const painted = root().locator(`[data-shape-id=${JSON.stringify(id)}]`).first();
      const beforeCamera = await session(path);
      const beforePaint = await painted.boundingBox();
      await h.input.wheel({ x: a.x + 30, y: a.y + 10, deltaY: -100, ctrl: true });
      await frames(h.page, 8);
      const zoomed = await session(path);
      const zoomPaint = await painted.boundingBox();
      if (!(zoomed.camera.zoom > beforeCamera.camera.zoom) || !beforePaint || !zoomPaint || !(zoomPaint.width > beforePaint.width)) fail('session.camera.zoom', 'real zoom and painted stroke did not both grow');
      if (!(zoomed.viewport.world.width < beforeCamera.viewport.world.width) || !(zoomed.viewport.world.height < beforeCamera.viewport.world.height)) fail('session.viewport.world.width/height', 'zoom did not shrink both world-view dimensions');
      add(['session.camera.zoom', 'session.viewport.world.width', 'session.viewport.world.height'], kind, 'action', { before: beforeCamera.camera, after: zoomed.camera, beforeWorld: beforeCamera.viewport.world, afterWorld: zoomed.viewport.world, paintedWidths: [beforePaint.width, zoomPaint.width] });
      const panStart = { x: rectangle.x + rectangle.width * .55, y: rectangle.y + rectangle.height * .50 };
      await h.input.settleModifiers(14, { minimumMs: 300, path, point: panStart, release: ['ctrl'] });
      await h.input.pointer('mousePressed', panStart, { kind: 'mouse', button: 'middle', buttons: 4 });
      await h.input.pointer('mouseMoved', { x: panStart.x + 45, y: panStart.y + 40 }, { kind: 'mouse', button: 'none', buttons: 4 });
      await h.input.pointer('mouseReleased', { x: panStart.x + 45, y: panStart.y + 40 }, { kind: 'mouse', button: 'middle', buttons: 0 });
      await frames(h.page, 5);
      const panned = await session(path);
      if (panned.camera.x === zoomed.camera.x || panned.camera.y === zoomed.camera.y) fail('session.camera.x/y', 'real pan must change both camera coordinates in the control fixture');
      if (panned.viewport.world.x === zoomed.viewport.world.x || panned.viewport.world.y === zoomed.viewport.world.y) fail('session.viewport.world.x/y', 'real pan did not change both world-view origins');
      add(['session.camera.x', 'session.camera.y', 'session.viewport.world.x', 'session.viewport.world.y'], kind, 'action', { before: zoomed.camera, after: panned.camera });
      const beforeViewport = await session(path);
      const viewport = h.page.viewportSize();
      await h.page.setViewportSize({ width: viewport.width - 120, height: viewport.height - 80 });
      await frames(h.page, 8);
      const resized = await session(path);
      const visible = await root().boundingBox();
      if (!visible || resized.viewport.css.width === beforeViewport.viewport.css.width || resized.viewport.css.height === beforeViewport.viewport.css.height) fail('session.viewport.css.width/height', 'real viewport resize did not change the observed box');
      for (const key of ['width', 'height']) if (Math.abs(resized.viewport.css[key] - visible[key]) > 1) fail(`session.viewport.css.${key}`, 'probe and actual DOM rectangle disagree');
      add(['session.viewport.css.width', 'session.viewport.css.height'], kind, 'action', { before: beforeViewport.viewport.css, after: resized.viewport.css, publicRectangle: visible });
      await h.page.setViewportSize(viewport);
      await frames(h.page, 8);
      if (kind !== 'drawing') {
        const before = await session(path);
        if (!before.backdrops.length || before.backdrops.some(page => page.locked !== true)) fail('session.backdrops[].locked', 'paged fixture must start with locked structural pages');
        const area = await root().boundingBox();
        await h.page.mouse.click(area.x + area.width * .78, area.y + area.height * .45, { button: 'right' });
        await h.page.getByRole('menuitem', { name: 'Edit', exact: true }).hover();
        const unlock = h.page.getByRole('menuitem', { name: /^Toggle locked(?:\s|$)/ });
        await unlock.waitFor({ state: 'visible' });
        if (await unlock.count() !== 1 || !await unlock.isEnabled()) fail('session.backdrops[].locked', 'no real enabled Edit → Toggle locked control');
        await unlock.click();
        await frames(h.page, 3);
        const after = await session(path);
        if (after.backdrops.length !== before.backdrops.length || after.backdrops.some(page => page.locked !== false)) fail('session.backdrops[].locked', 'Toggle locked did not change the observed backdrop locks');
        add(['session.pages[].locked', 'session.backdrops[].locked'], kind, 'action', { before: before.backdrops.map(page => ({ id: page.id, locked: page.locked })), after: after.backdrops.map(page => ({ id: page.id, locked: page.locked })), action: 'actual Edit → Toggle locked on a locked page (legacy reference, not target behaviour)' });
      }
      requireValue('path', await h.probe.binding(path), binding, 'actions stayed bound to the same editor object');
      return journal.filter(row => row.kind === kind && row.mode === 'action');
    },
    async persistedPair({ first, second }) {
      if (first === second) fail('persisted-pair', 'two distinct app-written fixture paths are required');
      const expectedA = (await h.probe.saved(first)).sort((a, b) => a.id.localeCompare(b.id));
      const expectedB = (await h.probe.saved(second)).sort((a, b) => a.id.localeCompare(b.id));
      const fields = PERSISTED_FIELDS.filter(field => canonical(valueSet(valuesOf(expectedA, field))) !== canonical(valueSet(valuesOf(expectedB, field))));
      if (!fields.length) fail('persisted-pair', 'fixtures have no known differing scalar fields');
      const observations = [];
      for (const path of [first, second, first]) {
        await h.ui.openFile(path);
        const expectedNodes = path === first ? expectedA : expectedB;
        const actual = (await h.probe.today(path)).sort((a, b) => a.id.localeCompare(b.id));
        for (const field of fields) requireValue(`nodes[].${field}`, valuesOf(actual, field), valuesOf(expectedNodes, field), `real UI opened ${path}`);
        observations.push({ path, binding: await h.probe.binding(path), fields: Object.fromEntries(fields.map(field => [field, valuesOf(actual, field)])) });
      }
      add(fields.map(field => `nodes[].${field}`), kindOf(first), 'file-pair', { order: [first, second, first], observations });
      return { controlled: fields, uncontrolled: PERSISTED_FIELDS.filter(field => !fields.includes(field)), observations };
    },
  };
}

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scratch } from './lock.mjs';
import { shiftInterval } from './stats.mjs';
import { metricFloors } from './metricFloors.mjs';

export const openingSessionsPerArm = 20;
const invalid = message => Object.assign(new Error(message), { invalidCause: message });
function context(lock, definition) {
    if (!definition?.id || !/^[a-f0-9]{64}$/.test(definition.hash)) throw new Error('Timed metric needs an explicit definition id/hash');
    const window = lock.holder.grant.window;
    const [hours, minutes, seconds] = window.since.split(':').map(Number);
    const began = new Date(); began.setHours(hours, minutes, seconds, 0);
    if (began.getTime() > Date.now()) began.setDate(began.getDate() - 1);
    const windowId = createHash('sha256').update(JSON.stringify({ window, began: began.toISOString() })).digest('hex');
    const key = `${definition.id}@${definition.hash}`;
    const keyHash = createHash('sha256').update(key).digest('hex');
    const folder = join(scratch, 'v-c/reports/window-calibrations');
    return { window, windowId, definition, key, keyHash, floor: metricFloors[key] ?? null,
        folder, path: join(folder, `${windowId}-${keyHash}.json`) };
}
async function existing(path) {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}
export async function publishOpeningCalibration(lock, report, sourceReport) {
    await lock.assertHeld();
    if (report.mode !== 'window' || report.status !== 'calibration-complete-NOT-A-GATE') throw new Error('Only a session-valid WINDOW calibration can publish an opening block');
    const c = context(lock, report.metricDefinition);
    if (JSON.stringify(report.lock.grant.window) !== JSON.stringify(c.window)) throw invalid('Opening calibration belongs to another window');
    if (await existing(c.path)) throw invalid(`Opening block already recorded for this metric/window; never replace it: ${c.path}`);
    if (!c.floor) {
        const prior = await readdir(c.folder).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
        if (prior.some(name => name.endsWith(`-${c.keyHash}.json`))) throw invalid('This definition already has an unreviewed recorded floor; compile the reviewed value before a later window');
    }
    const valid = report.sessions.filter(s => s.validity.valid && s.measurement);
    const arms = Object.fromEntries(['A', 'B'].map(arm => [arm, valid.filter(s => s.arm === arm).slice(0, openingSessionsPerArm)]));
    if (arms.A.length !== openingSessionsPerArm || arms.B.length !== openingSessionsPerArm) throw new Error('Opening block requires20+20 valid sessions');
    if (valid.some(s => s.measurement.metricDefinition?.hash !== c.definition.hash)) throw new Error('Opening metric definition changed');
    if (valid.some(s => s.measurement.values.length !== 1)) throw new Error('Opening publisher requires one scalar per session; percentile adapters must explicitly reduce with the shared method');
    const values = Object.fromEntries(['A', 'B'].map(arm => [arm, arms[arm].map(s => s.measurement.values[0])]));
    const controlBuild = report.identities.A.sha256;
    if (controlBuild !== report.identities.B.sha256) throw new Error('Opening arms are not the same build');
    const interval = shiftInterval(values.A, values.B, { alpha: 0.05, relative: true });
    const halfWidth = (interval.upper - interval.lower) / 2;
    if (!Number.isFinite(halfWidth)) throw invalid('Opening block has no finite exact interval');
    if (c.floor && (c.floor.perArm !== openingSessionsPerArm || !Number.isFinite(c.floor.relativeHalfWidth95)
        || c.floor.controlBuild !== controlBuild)) throw new Error('Compiled metric floor is incompatible; reviewed re-recording required');
    const record = { schema: 2, key: c.key, definition: c.definition, window: c.window, windowId: c.windowId,
        sourceReport, recordedAt: new Date().toISOString(), controlBuild, values, interval, halfWidth,
        perArm: openingSessionsPerArm, floor: c.floor,
        status: !c.floor ? 'recorded' : halfWidth <= c.floor.relativeHalfWidth95 ? 'valid' : 'invalid',
        recordMode: !c.floor,
        interpretation: c.floor ? 'Opening block checked against reviewed compiled floor.'
            : 'FIRST WINDOW: session bounds1–5 only; this block records its floor and is NOT compared with itself. vr-lead reviews/amends it after the window; no silent reuse in later windows.',
        candidateFloor: { perArm: openingSessionsPerArm, relativeHalfWidth95: halfWidth, controlBuild, sourceReport } };
    if (record.status === 'invalid') record.reason = `Opening relative HL95 half-width ${halfWidth} exceeds compiled floor ${c.floor.relativeHalfWidth95}`;
    await mkdir(c.folder, { recursive: true });
    const temp = `${c.path}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(record, null, 4) + '\n'); await rename(temp, c.path);
    if (record.status === 'invalid') throw invalid(`WHOLE WINDOW INVALID: ${record.reason}; ${c.path}`);
    return { path: c.path, record };
}
export async function windowCalibration(lock, config, identities) {
    const c = context(lock, config.metricDefinition);
    const record = await existing(c.path);
    if (!record) throw invalid(`Opening20+20 calibration for ${c.key} must run before timed arms; ${c.path}`);
    if (record.status === 'invalid') throw invalid(`WHOLE WINDOW INVALID: ${record.reason}; ${c.path}`);
    if (record.key !== c.key || record.controlBuild !== identities.A.sha256) throw invalid('Window proof does not match the metric definition/control build');
    if (c.floor && (record.recordMode || record.halfWidth > c.floor.relativeHalfWidth95)) throw invalid('Window proof does not meet the reviewed compiled floor');
    if (!c.floor && !record.recordMode) throw invalid('Unreviewed floor must be recorded, not silently adopted');
    return { path: c.path, record,
        async observe() { return record; },
        assertValid() {
            if (!['valid', 'recorded'].includes(record.status)) throw invalid('Opening calibration incomplete/invalid');
        } };
}

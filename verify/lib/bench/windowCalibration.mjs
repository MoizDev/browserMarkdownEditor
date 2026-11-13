import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scratch } from './lock.mjs';
import { shiftInterval } from './stats.mjs';

// timing-window-bound.md §4, from the OBSERVED 10/arm prefix of floor-3-calibration.json.
// One fixed opening block uses its ordinary exact 95% interval, not a gate's look
// correction. This admits the measured floor; it NEVER changes the 5% pass rule.
export const openingFloor = Object.freeze({ perArm: 10,
    relativeHalfWidth95: (0.05314799648049103 - (-0.1278127811776858)) / 2,
    controlBuild: '4d0b8bec0eea7390d86334d93dd3aa79ea66212d0ca06811a2809b3bedccdfa8',
    evidence: 'measure/floor-3-calibration.json, observed[0].relativeHL95' });
export async function windowCalibration(lock, config, identities, reportPath) {
    const window = lock.holder.grant.window;
    const [hours, minutes, seconds] = window.since.split(':').map(Number);
    const began = new Date(); began.setHours(hours, minutes, seconds, 0);
    if (began.getTime() > Date.now()) began.setDate(began.getDate() - 1);
    const id = createHash('sha256').update(JSON.stringify({ window, began: began.toISOString() })).digest('hex');
    const folder = join(scratch, 'v-c/reports/window-calibrations');
    const path = join(folder, `${id}.json`);
    let record;
    try { record = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const opener = config.openingControl === true && config.gate === 'open-vault' && config.temperature === 'cold'
        && config.metric.name === 'openToPaintMs' && config.metric.rule === 'no-regression'
        && !config.metric.percentile && config.metric.comparison === 'relative'
        && identities.A.sha256 === openingFloor.controlBuild && identities.B.sha256 === openingFloor.controlBuild;
    const invalid = message => Object.assign(new Error(message), { invalidCause: message });
    if (record?.status === 'valid' && !(record.halfWidth <= openingFloor.relativeHalfWidth95)) throw invalid(`Window proof does not meet the current measured floor; ${path}`);
    if (record?.status === 'invalid') throw invalid(`Whole window invalid: ${record.reason}; ${path}`);
    if (!record && !opener) throw invalid(`Window has no valid opening 10+10 V-04 control block; ${path}`);
    return { path, get record() { return record; },
        async observe(arms) {
            if (record) return record;
            if (arms.A.length < openingFloor.perArm || arms.B.length < openingFloor.perArm) return null;
            const values = Object.fromEntries(['A', 'B'].map(arm => [arm, arms[arm].slice(0, openingFloor.perArm).map(s => s.values[0])]));
            const interval = shiftInterval(values.A, values.B, { alpha: 0.05, relative: true });
            const halfWidth = (interval.upper - interval.lower) / 2;
            record = { id, window, sourceReport: reportPath, recordedAt: new Date().toISOString(),
                status: halfWidth <= openingFloor.relativeHalfWidth95 ? 'valid' : 'invalid',
                values, interval, halfWidth, floor: openingFloor };
            if (record.status === 'invalid') record.reason = `Opening relative HL95 half-width ${halfWidth} exceeds measured floor ${openingFloor.relativeHalfWidth95}`;
            await mkdir(folder, { recursive: true });
            const temp = `${path}.${process.pid}.tmp`;
            await writeFile(temp, JSON.stringify(record, null, 4) + '\n'); await rename(temp, path);
            if (record.status === 'invalid') throw invalid(`Whole window INVALID: ${record.reason}; ${path}`);
            return record;
        },
        assertValid() {
            if (record?.status !== 'valid') throw invalid('Window opening calibration was not completed/valid');
        },
    };
}

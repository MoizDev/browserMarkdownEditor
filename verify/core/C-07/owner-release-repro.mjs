import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openFixture, scratch, until } from './fixture.mjs';
import { toolText } from '../lib/helper.mjs';

const output = resolve(scratch, 'owner-release-repro');
await mkdir(output, { recursive: true });
let fixture;
let report = {};
try {
    fixture = await openFixture({ id: 'owner-release-repro' });
    report = fixture.report;
    const result = await fixture.helper.sendTool('vault_search', { query: 'needle', path: 'control.md' }).result;
    assert(toolText(result).includes('control.md:1: needle control'));
    fixture.helper.finishRun();
    await fixture.page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'hidden' });
    report.before = await fixture.read();
    assert.equal(fixture.targets.read().alive.length, 1, 'The completed query leaves one reusable idle worker');
    await fixture.switchVault();
    await until(async () => {
        report.after = await fixture.read();
        return report.after.perf.length === 0 && fixture.targets.read().alive.length === 0;
    }, 'Closing the old vault must dispose its idle matcher owner, not retain a worker or registry entry', 3000);
    assert.equal(report.errors.length, 0);
    assert.equal(report.after.rejections.length, 0);
    console.log(JSON.stringify({ cell: report.id, passed: true, targets: fixture.targets.read() }));
} catch (error) {
    report.failure = String(error);
    if (fixture) await fixture.page.screenshot({ path: resolve(output, 'failure.png') }).catch(() => {});
    console.error(JSON.stringify({ cell: 'owner-release-repro', failure: report.failure, after: report.after?.perf }));
    throw error;
} finally {
    if (fixture) await fixture.close();
    await writeFile(resolve(output, 'observation.json'), JSON.stringify(report, null, 2));
}

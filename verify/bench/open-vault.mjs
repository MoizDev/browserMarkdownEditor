// Run through bme-lock run (exploration) or bme-lock bench (a declared timing window).
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBenchmark } from '../lib/bench/runner.mjs';
import { openVaultAdapter } from '../lib/bench/browser.mjs';

const [armA, armB, mode = 'exploratory', temperature = 'cold', noiseReport, confirmReport] = process.argv.slice(2);
if (!armA || !armB || !['exploratory', 'accepted'].includes(mode)) {
    throw new Error('Usage: node verify/bench/open-vault.mjs <dist-A> <dist-B> [exploratory|accepted] [cold|warm] [noise-report.json|-] [confirm-report.json]');
}
const result = await runBenchmark({
    gate: 'open-vault', mode, temperature, methodCheck: true,
    noiseReport: noiseReport && noiseReport !== '-' ? resolve(noiseReport) : null,
    confirmReport: confirmReport ? resolve(confirmReport) : null,
    scriptFiles: [fileURLToPath(import.meta.url), fileURLToPath(new URL('../lib/bench/browser.mjs', import.meta.url))],
    arms: { A: { dist: resolve(armA) }, B: { dist: resolve(armB) } },
    metric: { name: 'openToPaintMs', unit: 'ms', rule: 'no-regression',
        comparison: 'relative', threshold: 0.05, lowerIsBetter: true },
    // Small runs exercise the app and reporting only, and can never receive a pass.
    exploratorySessions: 2,
    inputScript: ['fresh named OPFS vault; seed and read first-note.md once',
        'real Open Vault click', 'real first-note tree-row click', 'first note visible; two animation frames'],
    witness: 'Non-default sentinel text is visible in CodeMirror; screenshot and trace retained.',
    identity: 'SHA-256 of every served build file, checked again after all sessions; exact pinned Chrome version.',
    mutant: 'verify/bench/build-delay.mjs patches only a scratch source copy; delay calibrated to 10% of control median.',
    falsePass: 'Noise swallows a 10% shift; the 95% interval half-width must be <= 5%/3, otherwise inconclusive.',
    losses: ['One machine, headless, OPFS rather than a native picker/disk.',
        'Coverage-mask/under-reported-hole gates await C9 and are NOT covered.',
        'Two-rAF paint boundary is a proxy; trace and screenshot witness actual content, not photon latency.',
        'Tree-row click includes browser-driver scheduling; no cold-disk claim.',
        'Process memory sampled before/after, not a peak measurement.'],
}, openVaultAdapter);
console.log(result.reportPath);
process.exitCode = ['pass', 'exploratory'].includes(result.status) ? 0 : 1;

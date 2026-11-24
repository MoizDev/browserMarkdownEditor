// Static lint gate: run the proposed I-3 rule on the five real old files, then
// on a sixth value caller. No app module is imported or executed.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ESLint } from 'eslint';

const [policyPath, out] = process.argv.slice(2);
if (!policyPath || !out) throw new Error('Usage: lint-witness.mjs <I-3-rule-module> <output-dir>');
const { classicPdfOpenRule } = await import(pathToFileURL(resolve(policyPath)).href);
const { default: base } = await import(new URL('../../../eslint.config.ts', import.meta.url));
const ruleId = 'classic-policy/open';
const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: [...base, {
    files: ['src/**/*.{ts,tsx}'], ignores: ['src/utils/pdfClassicOpen.ts'],
    plugins: { 'classic-policy': { rules: { open: classicPdfOpenRule } } }, rules: { [ruleId]: 'error' },
}] });
const oldCommit = 'd53ae0a5c6a4b000c01ec83d487d608bc3f11895';
const report = { gate: 'P-02a proposed lint policy', oldCommit, policySha256: createHash('sha256').update(await readFile(policyPath)).digest('hex'), before: [], controls: [], loss: 'Until I-3 applies this same rule, repository npm run lint has no classic-open ban. Re-run this witness with the production rule at integration.' };
for (const file of ['src/utils/pdfDocumentSession.ts', 'src/utils/pdfAnnotation.ts', 'src/utils/pdfText.ts', 'src/components/PdfAnnotateCanvas.tsx']) {
    const code = execFileSync('git', ['show', `${oldCommit}:${file}`], { encoding: 'utf8' });
    const [result] = await eslint.lintText(code, { filePath: file });
    report.before.push({ file, violations: result.messages.filter(m => m.ruleId === ruleId) });
}
for (const [name, filePath, code, shouldFail] of [
    ['sixth-caller', 'src/utils/pdfForgottenCaller.ts', "import { getDocument as forgottenOpen } from 'pdfjs-dist'; forgottenOpen({});", true],
    ['namespace-alias', 'src/utils/pdfForgottenCaller.ts', "import * as p from 'pdfjs-dist'; p['getDocument']({});", true],
    ['namespace-escape', 'src/utils/pdfForgottenCaller.ts', "import * as p from 'pdfjs-dist'; const alias = p; alias.getDocument({});", true],
    ['dynamic-escape', 'src/utils/pdfForgottenCaller.ts', "const p = await import('pdfjs-dist'); p.getDocument({});", true],
    ['type-only', 'src/utils/pdfForgottenCaller.ts', "import type { getDocument } from 'pdfjs-dist'; export type Factory = typeof getDocument;", false],
    ['sole-adapter', 'src/utils/pdfClassicOpen.ts', "import { getDocument } from 'pdfjs-dist'; getDocument({});", false],
]) {
    const [result] = await eslint.lintText(code, { filePath });
    const violations = result.messages.filter(m => m.ruleId === ruleId);
    report.controls.push({ name, shouldFail, violations, pass: shouldFail === (violations.length > 0) });
}
await mkdir(out, { recursive: true });
await writeFile(resolve(out, 'lint-witness.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ before: report.before.map(r => ({ file: r.file, violations: r.violations.length })), controls: report.controls.map(c => ({ name: c.name, pass: c.pass })) }, null, 2));
if (report.before.reduce((count, r) => count + r.violations.length, 0) !== 5 || report.controls.some(c => !c.pass)) process.exitCode = 1;

import { ESLint } from 'eslint';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// This is the static gate's deliberately violating source, not an app-module
// invocation. The rule must reject every regex syntax even with a literal query.
const source = "void /linear/u;\nvoid new RegExp('linear');\nvoid RegExp('linear');\n";
const eslint = new ESLint();
const observations = [];
for (const filePath of ['src/utils/pdfFind.ts', 'src/utils/pdfTextAnchors.ts']) {
    const [result] = await eslint.lintText(source, { filePath });
    const errors = result.messages.filter(message => message.severity === 2);
    const pass = errors.length === 3 && errors.every(message => message.ruleId === 'no-restricted-syntax');
    observations.push({ filePath, pass, messages: errors });
}
const out = resolve(process.env.BME_OUT ?? '/Users/adham/Developer/bme-impl/scratch/p-b/lint-witness');
await mkdir(out, { recursive: true });
await writeFile(resolve(out, 'results.json'), JSON.stringify({ source, observations }, null, 2) + '\n');
if (observations.some(observation => !observation.pass)) process.exitCode = 1;
console.log(JSON.stringify(observations, null, 2));

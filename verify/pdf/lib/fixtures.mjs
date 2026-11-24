import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function pdfFixtureManifest(commit) {
    const bytes = commit ? execFileSync('git', ['show', `${commit}:verify/fixtures/pdf/manifest.json`]) : await readFile(new URL('../../fixtures/pdf/manifest.json', import.meta.url));
    return { data: JSON.parse(bytes), identity: { file: 'verify/fixtures/pdf/manifest.json', commit: execFileSync('git', ['rev-parse', commit ?? 'HEAD'], { encoding: 'utf8' }).trim(), sha256: hash(bytes) } };
}

export async function readPdfFixture(id, directory, manifest) {
    const admitted = manifest.data.fixtures.find(entry => entry.id === id);
    if (!admitted || !admitted.file.endsWith('.pdf')) throw new Error(`Missing PDF admission: ${id}`);
    const oracleFile = typeof admitted.expected === 'string' ? admitted.expected : admitted.file.replace(/\.pdf$/, '.expected.json');
    const oracleAdmission = manifest.data.fixtures.find(entry => entry.file === oracleFile);
    if (!oracleAdmission) throw new Error(`Missing oracle admission: ${id}`);
    const bytes = await readFile(resolve(directory, admitted.file));
    const oracleBytes = await readFile(resolve(directory, oracleFile));
    if (bytes.length !== admitted.bytes || hash(bytes) !== admitted.sha256 || oracleBytes.length !== oracleAdmission.bytes || hash(oracleBytes) !== oracleAdmission.sha256) throw new Error(`Fixture identity mismatch: ${id}`);
    const oracle = JSON.parse(oracleBytes);
    if (oracle.id && (oracle.id !== id || oracle.sha256 !== admitted.sha256)) throw new Error(`Oracle identity mismatch: ${id}`);
    return { id, file: admitted.file, bytes, oracle, admission: { ...admitted, manifest: manifest.identity } };
}

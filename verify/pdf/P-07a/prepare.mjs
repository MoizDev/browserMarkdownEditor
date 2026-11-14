import { resolve } from 'node:path';
import { prepareApp } from '../../lib/serve.mjs';

if (process.argv.length !== 2) throw new Error('Preparation accepts environment configuration only');
const mode = process.env.BME_MODE ?? 'production';
if (!['dev', 'production'].includes(mode)) throw new Error('BME_MODE must be dev or production');
const prepared = await prepareApp({ root: resolve(process.env.BME_ROOT ?? '.'),
    scratch: resolve(process.env.BME_SCRATCH ?? `/Users/adham/Developer/bme-impl/scratch/p-b/${mode}`), mode });
console.log(JSON.stringify({ root: prepared.root, scratch: prepared.scratch, identity: prepared.identity.manifestSha256 }));

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** Docker commands are local-only and use the integrator's one charged VM.
 * Never inherit credentials, credential helpers or a person's active remote context.
 */
export async function isolatedDockerEnv(scratch) {
    if (!process.env.DOCKER_HOST?.startsWith('unix://') || !process.env.DOCKER_HOST.endsWith('/bme/docker.sock')) throw new Error('Use scratch/bin/bme-vm run --; no remote Docker endpoint or user context is allowed');
    const config = resolve(scratch, 'docker-config');
    await mkdir(config, { recursive: true });
    const clean = JSON.stringify({ auths: {}, cliPluginsExtraDirs: [resolve(homedir(), '.docker/cli-plugins'), '/opt/homebrew/lib/docker/cli-plugins', '/usr/local/lib/docker/cli-plugins', '/usr/libexec/docker/cli-plugins'] });
    try {
        await writeFile(resolve(config, 'config.json'), clean, { flag: 'wx', mode: 0o600 });
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (await readFile(resolve(config, 'config.json'), 'utf8') !== clean) throw new Error('Unexpected existing Docker config; not overwriting it');
    }
    const env = { ...process.env, DOCKER_CONFIG: config, BUILDX_BUILDER: 'default', DOCKER_BUILDKIT: '1' };
    delete env.DOCKER_CONTEXT;
    return env;
}

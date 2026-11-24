import { reclaimBenchLock } from '../lib/bench/lock.mjs';

const [command, token, ...cause] = process.argv.slice(2);
if (command !== 'reclaim' || !token || !cause.length) {
    throw new Error('Usage: node verify/bench/v-c.mjs reclaim <exact-token> <cause>');
}
console.log(JSON.stringify(await reclaimBenchLock(token, cause.join(' ')), null, 4));

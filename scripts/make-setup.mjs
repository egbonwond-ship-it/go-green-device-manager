// Writes the setup file the console's "Enrol devices" window downloads, for CI to run.
//   node scripts/make-setup.mjs <windows|unix> <server> <token> <out-file>
import { writeFileSync } from 'fs';
import { windowsSetup, unixSetup } from '../app/js/agent-setup.js';
globalThis.btoa ??= s => Buffer.from(s, 'binary').toString('base64');
const [kind, server, token, out] = process.argv.slice(2);
writeFileSync(out, kind === 'windows' ? windowsSetup(server, token) : unixSetup(server, token));
console.log(`Wrote ${out}`);

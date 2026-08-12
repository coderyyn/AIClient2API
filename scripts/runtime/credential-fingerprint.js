import fs from 'fs';
import { createCredentialManifest, fingerprintCredentialManifest } from '../../src/runtime/credential-manifest.js';

const path = process.argv[2];
if (!path) throw new Error('Usage: node scripts/runtime/credential-fingerprint.js <provider_pools.json>');
const pools = JSON.parse(fs.readFileSync(path, 'utf8'));
const manifest = createCredentialManifest(pools);
process.stdout.write(`${JSON.stringify({ fingerprint: fingerprintCredentialManifest(manifest), manifest }, null, 2)}\n`);


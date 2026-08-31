// Writes the domain list from tools/domains.mjs into manifest.json, in all
// three places Chrome wants it. Run after editing DOMAINS:
//   node tools/make-manifest.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { MATCHES } from './domains.mjs';

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));

manifest.host_permissions = [...MATCHES];
for (const script of manifest.content_scripts) script.matches = [...MATCHES];
for (const res of manifest.web_accessible_resources) res.matches = [...MATCHES];

writeFileSync('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(`manifest.json now covers ${MATCHES.length} domains`);

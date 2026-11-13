import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';

await mkdir('desktop/generated', { recursive: true });
const result = await build({
  entryPoints: ['node_modules/electron-updater/out/main.js'],
  outfile: 'desktop/generated/updater.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  legalComments: 'external',
  metafile: true,
});
// Bundling removes node_modules from the installer, so carry the bundled
// packages' license notices alongside the generated code.
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  let folder = dirname(resolve(input));
  while (folder.includes('node_modules')) {
    const manifest = join(folder, 'package.json');
    if (existsSync(manifest)) {
      const metadata = JSON.parse(await readFile(manifest, 'utf8'));
      if (metadata.name && !packages.has(`${metadata.name}@${metadata.version}`)) {
        const name = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'COPYING'].find(file => existsSync(join(folder, file)));
        const license = name ? await readFile(join(folder, name), 'utf8') : `License: ${metadata.license || 'See package metadata'}`;
        packages.set(`${metadata.name}@${metadata.version}`, license.trim());
      }
      break;
    }
    const parent = dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
}
await writeFile('desktop/generated/THIRD-PARTY-LICENSES.txt', [...packages].map(([name, license]) => `${name}\n${'='.repeat(name.length)}\n${license}\n`).join('\n'), 'utf8');

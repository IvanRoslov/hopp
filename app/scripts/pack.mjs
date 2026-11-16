// Packs the app into an unsigned macOS bundle: app/dist/hopp-darwin-arm64/hopp.app.
// Run through `make app-pack` (which builds first). Not signed, not notarized.
import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const work = join(root, 'dist', '.icon');

// The app icon: build/icon.png (1024 px, drawn from the prototype's mark)
// turned into an .icns with the macOS tools.
function makeIcns() {
  rmSync(work, { recursive: true, force: true });
  const set = join(work, 'hopp.iconset');
  mkdirSync(set, { recursive: true });
  for (const size of [16, 32, 64, 128, 256, 512]) {
    for (const [scale, px] of [[1, size], [2, size * 2]]) {
      const name = scale === 1 ? `icon_${size}x${size}.png` : `icon_${size}x${size}@2x.png`;
      execFileSync('sips', ['-z', String(px), String(px), join(root, 'build', 'icon.png'), '--out', join(set, name)], { stdio: 'ignore' });
    }
  }
  const icns = join(work, 'hopp.icns');
  execFileSync('iconutil', ['-c', 'icns', set, '-o', icns]);
  return icns;
}

const keep = /^\/(out|node_modules|package\.json)(\/|$)/;
const paths = await packager({
  dir: root,
  name: 'hopp',
  platform: 'darwin',
  arch: 'arm64',
  out: join(root, 'dist'),
  overwrite: true,
  icon: makeIcns(),
  appBundleId: 'local.hopp.app',
  appCategoryType: 'public.app-category.developer-tools',
  // Only the build output and the runtime dependencies go in.
  ignore: (p) => p !== '' && !keep.test(p),
  prune: true,
  // node-pty's native module and its spawn-helper must live outside the
  // asar archive to be loaded and executed.
  asar: { unpack: '**/node_modules/node-pty/**' },
});

// Keep the executable bit of spawn-helper (posix_spawnp fails without it).
for (const out of paths) {
  const base = join(out, 'hopp.app', 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds');
  if (!existsSync(base)) throw new Error('node-pty was not unpacked from the asar archive: ' + base);
  for (const dir of readdirSync(base)) {
    const helper = join(base, dir, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
  console.log('packed:', join(out, 'hopp.app'));
}
rmSync(work, { recursive: true, force: true });

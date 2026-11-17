// The app's commands (hopp project / pipeline / task) as one self-contained
// CommonJS file, out/cli/hopp-shell.cjs, that runs on plain Node: the app's
// own (ELECTRON_RUN_AS_NODE) once packed. It uses only Node's built-ins.
import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'src/cli/main.ts',
    outDir: 'out/cli',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map((m) => 'node:' + m)],
      output: { format: 'cjs', entryFileNames: 'hopp-shell.cjs', codeSplitting: false },
    },
  },
  ssr: { noExternal: true },
});

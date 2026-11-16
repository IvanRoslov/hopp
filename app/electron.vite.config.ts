import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    build: {
      // node-pty is a native module: it stays a runtime require from node_modules.
      externalizeDeps: true,
    },
  },
  preload: {
    build: {
      // A sandboxed preload cannot be an ES module: emit CommonJS.
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react()],
  },
});

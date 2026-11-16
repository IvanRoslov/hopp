import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'main', environment: 'node', include: ['src/main/**/*.test.ts', 'src/shared/**/*.test.ts'] },
      },
      {
        extends: true,
        test: { name: 'renderer', environment: 'jsdom', environmentOptions: { jsdom: { url: 'http://localhost/' } }, setupFiles: ['test/setup-renderer.ts'], include: ['src/renderer/**/*.test.tsx', 'src/renderer/**/*.test.ts'] },
      },
    ],
    testTimeout: 15000,
  },
});

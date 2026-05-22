import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@falari-extension': path.resolve(__dirname, '../extension/src'),
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});

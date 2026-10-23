import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: false },
      '/mcp': 'http://localhost:8080',
      '/healthz': 'http://localhost:8080',
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});

// Vite config for @indiansassist/web. Tailwind CSS v4 is wired through its official Vite plugin.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, strictPort: true },
  preview: { port: 5173 },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true },
});

import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'src',
  publicDir: '../public',
  plugins: [tailwindcss()],
  server: {
    port: 3001,
    open: true,
  },
});

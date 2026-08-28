import { defineConfig } from 'vite';

const apiPort = process.env.API_PORT || 4000;

export default defineConfig({
  server: {
    port: Number(process.env.VITE_PORT) || 3000,
    open: true,
    proxy: {
      '/api': `http://localhost:${apiPort}`
    }
  }
});
import { defineConfig } from 'vite';

const apiPort = process.env.API_PORT || 8001;

export default defineConfig({
  server: {
    port: Number(process.env.VITE_PORT || process.env.PORT) || 8000,
    open: true,
    proxy: {
      '/api': `http://localhost:${apiPort}`
    }
  }
});
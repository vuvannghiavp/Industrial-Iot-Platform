import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    define: {
      'globalThis.__VITE_ENV__': JSON.stringify(env),
    },
    server: {
      port: 5173,
      host: true,
    },
    build: {
      target: 'es2022',
      outDir: 'dist',
    },
  };
});

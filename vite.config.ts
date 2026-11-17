import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// 纯前端静态构建；样例数据放在 public/sample-data，构建时原样拷贝
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});

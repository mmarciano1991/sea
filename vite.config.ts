import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // A dedicated port, so another local Vite project on 5173 can't shadow this one.
  server: { host: true, port: 5180, strictPort: true },
  preview: { host: true },
});

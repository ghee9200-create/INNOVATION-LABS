import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const tempBuildDir = path.join(rootDir, '.vite-build');

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, rootDir, '');
  const apiProxyTarget = String(env.API_PROXY_TARGET || '').trim();

  return {
  plugins: [
    react(),
    {
      name: 'emit-production-page-as-app-html',
      apply: 'build',
      writeBundle() {
        const staleBuildFiles = fs.readdirSync(rootDir)
          .filter((file) => file === 'app.html' || /^app[-\w]*\.(?:js|css)$/.test(file) || /^index-[\w-]+\.(?:js|css)$/.test(file));

        for (const file of staleBuildFiles) {
          fs.rmSync(path.join(rootDir, file), { force: true });
        }

        const builtIndexPath = path.join(tempBuildDir, 'index.html');
        if (!fs.existsSync(builtIndexPath)) return;

        const builtHtml = fs.readFileSync(builtIndexPath, 'utf8');
        fs.writeFileSync(path.join(rootDir, 'app.html'), builtHtml);

        for (const file of fs.readdirSync(tempBuildDir)) {
          if (file === 'index.html') continue;
          fs.copyFileSync(path.join(tempBuildDir, file), path.join(rootDir, file));
        }

        fs.rmSync(tempBuildDir, { recursive: true, force: true });
      },
    },
  ],
  build: {
    outDir: '.vite-build',
    emptyOutDir: true,
    assetsDir: '',
    rollupOptions: {
      input: 'index.html',
    },
  },
  server: {
    port: 3000,
    strictPort: true,
    host: '0.0.0.0',
    ...(apiProxyTarget ? { proxy: { '/api': apiProxyTarget } } : {}),
  },
  };
});

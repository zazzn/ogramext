import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { crx } from '@crxjs/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import manifest from './manifest.json';

/** The commit this is built from ("17562c3"), plus " + local changes" when the extension
 *  has uncommitted edits — or null outside a git checkout. Shown next to the version
 *  (chrome://extensions, Options → About) so a loaded build can be traced to its code. */
function buildId(): string | null {
  const cwd = fileURLToPath(new URL('.', import.meta.url));
  const git = (args: string) =>
    execSync(`git ${args}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  try {
    const hash = git('rev-parse --short=7 HEAD');
    const changed = git('--no-optional-locks status --porcelain --untracked-files=no -- .');
    return changed ? `${hash} + local changes` : hash;
  } catch {
    return null;
  }
}

const build = buildId();

export default defineConfig({
  plugins: [
    react(),
    crx({
      manifest: build
        ? { ...manifest, version_name: `${manifest.version} (build ${build})` }
        : manifest,
      browser: 'chrome',
    }),
  ],
  // harper.js resolves its WASM via `new URL(..., import.meta.url)`; esbuild
  // dep-optimization rewrites that incorrectly. Exclude it and load the wasm
  // from a stable public/ path via chrome.runtime.getURL instead.
  optimizeDeps: {
    exclude: ['harper.js'],
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'esnext', // don't down-level the wasm-bindgen glue / top-level await
    rollupOptions: {
      output: {
        chunkFileNames: 'assets/[hash].js',
        entryFileNames: 'assets/[hash].js',
      },
    },
  },
  server: {
    port: 5173,
    hmr: {
      port: 5173,
    },
    strictPort: true,
  },
});

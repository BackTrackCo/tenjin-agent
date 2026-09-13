import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { testEnv } from '../tests/setup/test-env';

// Copied into the fixture's .bench1 directory. This runs existing, visible
// source tests only; it never includes or imports a hidden behavioral oracle.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const original = path.join(root, 'tests/integration/_support/db');
const support = path.join(root, '.bench1/model-test-database.mjs');
export default {
  plugins: [
    react(),
    {
      name: 'benchmark-disposable-database',
      enforce: 'pre',
      resolveId(source, importer) {
        const candidate = source.startsWith('@/')
          ? path.join(root, source.slice(2))
          : source.startsWith('.') && importer
            ? path.resolve(path.dirname(importer.split('?')[0]), source)
            : source;
        if (candidate === original || candidate === original + '.ts') return support;
        return null;
      },
    },
  ],
  resolve: { alias: { '@': root } },
  cacheDir: '/tmp/benchmark-visible-vite-cache',
  test: {
    env: {
      ...testEnv,
      POSTGRES_URL: 'postgresql://postgres@127.0.0.1:5432/benchmark',
      POSTGRES_URL_NON_POOLING: 'postgresql://postgres@127.0.0.1:5432/benchmark',
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'source-node',
          environment: 'node',
          setupFiles: ['./tests/setup.ts'],
          include: ['tests/integration/**/*.test.ts', 'lib/**/*.test.ts', 'app/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'source-dom',
          environment: 'happy-dom',
          environmentOptions: {
            happyDOM: { settings: { navigation: { disableChildFrameNavigation: true } } },
          },
          exclude: ['app/write/_components/editor.test.tsx'],
          setupFiles: ['./tests/setup.dom.ts'],
          include: ['app/**/*.test.tsx', 'lib/**/*.test.tsx'],
          env: { NEXT_PUBLIC_APP_URL: 'https://tenjin.xyz', NEXT_PUBLIC_CHAIN_ID: '8453' },
        },
      },
      {
        extends: true,
        test: {
          name: 'source-editor',
          environment: 'jsdom',
          setupFiles: ['./tests/setup.dom.ts'],
          include: ['app/write/_components/editor.test.tsx'],
          env: { NEXT_PUBLIC_APP_URL: 'https://tenjin.xyz', NEXT_PUBLIC_CHAIN_ID: '8453' },
        },
      },
    ],
    exclude: ['**/node_modules/**', '**/*.fork.test.ts'],
    server: { deps: { inline: ['@x402/next'] } },
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
};

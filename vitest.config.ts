import { defineConfig } from 'vitest/config';

// Older runtimes lack the SQLite FTS5 build the proactivity store needs, which
// surfaces as scores of unrelated-looking failures instead of one clear cause.
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 24) {
  throw new Error(
    `Tests require Node 24 or later (see .tool-versions); running ${process.version}.`,
  );
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tools/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // tools/pm is exercised by `node --test`, which this provider cannot see.
      include: ['src/**/*.{ts,tsx}', 'tools/**/*.{ts,mjs}', 'scripts/**/*.ts'],
      exclude: ['**/*.test.*', '**/__tests__/**', 'src/test-support/**', 'tools/pm/**'],
      reporter: ['text-summary', 'html', 'json-summary'],
    },
  },
  resolve: {
    // TypeScript files import with .js extensions (NodeNext resolution).
    // Vitest needs to map those back to .ts for source resolution.
    extensionAlias: {
      '.js': ['.ts', '.js'],
    },
  },
});

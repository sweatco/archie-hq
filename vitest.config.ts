import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tools/**/*.test.ts'],
  },
  resolve: {
    // TypeScript files import with .js extensions (NodeNext resolution).
    // Vitest needs to map those back to .ts for source resolution.
    extensionAlias: {
      '.js': ['.ts', '.js'],
    },
  },
});

import { defineConfig } from 'vitest/config';

// Without a config of its own, `npm test` here walks up and loads the root
// project's vitest.config.mjs, whose custom reporter and setup file resolve
// against the repo root and cannot be found from this directory.
export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        // The live-server end-to-end run needs a server to talk to; it is opt-in
        // via `npx vitest run test/e2e.live-server.test.ts`.
        exclude: ['test/e2e.live-server.test.ts', 'node_modules/**'],
        environment: 'node'
    }
});

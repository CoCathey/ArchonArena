import { defineConfig } from 'vitest/config';

// Without a config of its own, `npm test` here walks up and loads the root
// project's vitest.config.mjs, whose custom reporter and setup file resolve
// against the repo root and cannot be found from this directory.
export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        exclude: ['node_modules/**'],
        // The live-server end-to-end test needs a running stack. It gates itself
        // on AA_E2E=1 (see its header) rather than being excluded here, so that
        // naming it explicitly still runs it.
        environment: 'node'
    }
});

module.exports = {
  testEnvironment: 'jsdom',
  testMatch: ["**/tests/**/*.test.ts"],
  collectCoverage: false,
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  moduleDirectories: ["node_modules", "src", "tests"],
  moduleFileExtensions: ['js', 'ts'],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
    "^obsidian$": "<rootDir>/tests/__mocks__/obsidian.ts",
    "^virtual:sqlite3-wasm-base64$": "<rootDir>/tests/fixtures/sqlite-wasm-asset.ts",
    "^virtual:sqlite3-mjs-text$": "<rootDir>/tests/fixtures/sqlite-mjs-asset.ts",
  },
  noStackTrace: true,
  // Capped deliberately. Jest defaults to roughly one worker per core, which is
  // fine for a single run and hostile when several run at once: multi-agent
  // workflows routinely invoke `bun run test` from three verification agents
  // simultaneously, and on 2026-08-21 that (together with load from another
  // project) drove this 8-core host to load ~39, exhausted 8 GiB of zram, spilled
  // 12 GiB to swap, and locked up the desktop.
  //
  // The suite finishes in a few seconds either way, so the ceiling costs nothing
  // in practice and bounds the worst case. Override for a one-off full-power run
  // with `bun x jest --maxWorkers=<n>`.
  maxWorkers: 2,
};

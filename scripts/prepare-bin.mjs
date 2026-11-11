import { chmod } from 'node:fs/promises';

await Promise.all([
  chmod(new URL('../dist/cli.js', import.meta.url), 0o755),
  chmod(new URL('../dist/mcp.js', import.meta.url), 0o755),
]);

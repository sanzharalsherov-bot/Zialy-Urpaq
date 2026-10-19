import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const server = spawn(process.execPath, ['apps/web/.next/standalone/apps/web/server.js'], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: process.env.SCHOOL_WEB_PORT || '3100',
    HOSTNAME: process.env.SCHOOL_WEB_HOST || '0.0.0.0',
  },
});

server.on('error', error => {
  process.stderr.write(`Could not start the standalone web server: ${error.message}\n`);
  process.exitCode = 1;
});
server.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.kill(signal));
}

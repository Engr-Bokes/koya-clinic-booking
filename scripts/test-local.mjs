import EmbeddedPostgres from 'embedded-postgres';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';

const dir = await mkdtemp(join(tmpdir(), 'careslot-pg-test-'));
const socket = net.createServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const password = randomBytes(24).toString('hex');
const pg = new EmbeddedPostgres({
  databaseDir: join(dir, 'data'), user: 'postgres', password, port,
  persistent: false, autoRehydrateSymlinks: true,
  onLog: () => {}, onError: message => console.error(String(message))
});
try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('careslot_test');
  const env = { ...process.env, TEST_DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:${port}/careslot_test` };
  console.log('Running integration tests against a fresh local PostgreSQL instance.');
  const child = spawn(process.execPath, ['--test', 'test/*.test.js'], { stdio: 'inherit', env, shell: false });
  const code = await new Promise(resolve => child.on('exit', resolve));
  process.exitCode = code ?? 1;
} finally {
  await pg.stop().catch(() => {});
  await rm(dir, { recursive: true, force: true });
}

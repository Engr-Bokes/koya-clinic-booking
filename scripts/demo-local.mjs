import EmbeddedPostgres from 'embedded-postgres';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
const dir = process.env.DEMO_RUNTIME_DIR;
if (!dir) throw new Error('Set DEMO_RUNTIME_DIR to an external temporary directory.');
await mkdir(dir, { recursive: true });
const dbPassword = randomBytes(24).toString('hex');
const apiKey = randomBytes(32).toString('hex');
const pg = new EmbeddedPostgres({
  databaseDir: join(dir, 'postgres'), user: 'postgres', password: dbPassword,
  port: 55439, persistent: false, autoRehydrateSymlinks: true,
  onLog: () => {}, onError: message => console.error(String(message))
});
let child;
async function stop() {
  if (child && !child.killed) {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
  await pg.stop();
}
try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('careslot_demo');
  await writeFile(join(dir, 'demo-config.json'), JSON.stringify({ apiKey }), { mode: 0o600 });
  child = spawn(process.execPath, ['server.js'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: `postgresql://postgres:${dbPassword}@127.0.0.1:55439/careslot_demo`, API_KEY: apiKey, PORT: '3040' }
  });
  let initialized = false;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch('http://127.0.0.1:3040/slots', { headers: { 'X-API-Key': apiKey } });
      if (r.ok) { initialized = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!initialized) throw new Error('Demo server did not start.');
  const tomorrow = new Date(); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1); tomorrow.setUTCHours(8, 0, 0, 0);
  const slots = Array.from({ length: 12 }, (_, i) => ({
    id: `demo-${i + 1}`,
    provider: i < 6 ? 'Dr Ade' : 'Dr Obi',
    start: new Date(tomorrow.getTime() + (i % 6) * 1800000).toISOString(),
    end: new Date(tomorrow.getTime() + ((i % 6) + 1) * 1800000).toISOString()
  }));
  const seed = await fetch('http://127.0.0.1:3040/reset', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey }, body: JSON.stringify({ slots }) });
  if (!seed.ok) throw new Error('Could not seed demo slots.');
  console.log('Local CareSlot demo ready at http://localhost:3040. Fictional slots only.');
  process.once('SIGINT', async () => { await stop(); process.exit(0); });
  process.once('SIGTERM', async () => { await stop(); process.exit(0); });
  await new Promise(resolve => child.once('exit', resolve));
} catch (error) {
  console.error('Demo failed:', error.message);
  await stop().catch(() => {});
  process.exitCode = 1;
}

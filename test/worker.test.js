const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Worker } = require('node:worker_threads');

test('shredder worker deletes file and emits progress', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devourer-worker-test-'));
  const filePath = path.join(dir, 'target.bin');
  fs.writeFileSync(filePath, 'worker secret');

  const phases = [];
  const result = await new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, '..', 'shredder-worker.js'), {
      workerData: { filePath },
    });

    worker.on('message', (message) => {
      if (message.type === 'progress') phases.push(message.progress.phase);
      if (message.type === 'done') resolve(message.result);
    });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`worker exited with code ${code}`));
    });
  });

  assert.equal(result.success, true);
  assert.equal(fs.existsSync(filePath), false);
  assert.ok(phases.includes('DATA 1/4 ZERO'));
  fs.rmSync(dir, { recursive: true, force: true });
});

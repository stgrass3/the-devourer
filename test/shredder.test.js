const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { shredFile } = require('../shredder');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devourer-test-'));
}

function writeTarget(dir, name = 'target.bin', content = 'secret data') {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

test('shredFile removes a normal file from a temp directory', () => {
  const dir = tempDir();
  const filePath = writeTarget(dir);

  const progress = [];
  const result = shredFile(filePath, (event) => progress.push(event.phase));

  assert.equal(result.success, true);
  assert.equal(fs.existsSync(filePath), false);
  assert.ok(progress.includes('DATA 1/4 ZERO'));
  assert.ok(progress.includes('DATA 4/4 ZERO'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('shredFile rejects directories', () => {
  const dir = tempDir();

  assert.throws(
    () => shredFile(dir),
    /target is not a regular file/
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('shredFile rejects hard-linked files', () => {
  const dir = tempDir();
  const filePath = writeTarget(dir, 'linked.bin');
  const linkedPath = path.join(dir, 'linked-copy.bin');
  fs.linkSync(filePath, linkedPath);

  assert.throws(
    () => shredFile(filePath),
    /hard links/
  );
  assert.equal(fs.existsSync(filePath), true);
  assert.equal(fs.existsSync(linkedPath), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('shredFile rejects symbolic links', (t) => {
  const dir = tempDir();
  const filePath = writeTarget(dir, 'real.bin');
  const linkPath = path.join(dir, 'link.bin');

  try {
    fs.symlinkSync(filePath, linkPath);
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    t.skip(`symbolic link unavailable: ${err.message}`);
    return;
  }

  assert.throws(
    () => shredFile(linkPath),
    /symbolic link/
  );
  assert.equal(fs.existsSync(filePath), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('shredFile clears read-only files before deletion', () => {
  const dir = tempDir();
  const filePath = writeTarget(dir, 'readonly.bin');
  fs.chmodSync(filePath, 0o444);

  const result = shredFile(filePath);

  assert.equal(result.success, true);
  assert.equal(fs.existsSync(filePath), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('shredFile rejects files locked by another process', { skip: process.platform !== 'win32' }, async () => {
  const dir = tempDir();
  const filePath = writeTarget(dir, 'locked.bin');
  const escapedPath = filePath.replace(/'/g, "''");
  const locker = spawn('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$fs=[IO.File]::Open('${escapedPath}',[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);` +
      `try { [Console]::Out.WriteLine('LOCKED'); [Console]::Out.Flush(); Start-Sleep -Seconds 15 }` +
      `finally { $fs.Dispose() }`,
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for file lock')), 5000);
      locker.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`file locker exited early with code ${code}`));
      });
      locker.stdout.once('data', (chunk) => {
        if (!String(chunk).includes('LOCKED')) return;
        clearTimeout(timer);
        resolve();
      });
    });

    assert.throws(
      () => shredFile(filePath),
      /target is locked by another process/
    );
    assert.equal(fs.existsSync(filePath), true);
  } finally {
    locker.kill();
    if (locker.exitCode === null) await once(locker, 'exit');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shredFile wipes NTFS alternate data streams', { skip: process.platform !== 'win32' }, () => {
  const dir = tempDir();
  const filePath = writeTarget(dir, 'ads.bin', 'base stream');

  execFileSync('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Set-Content -LiteralPath '${filePath.replace(/'/g, "''")}' -Stream hidden -Value 'hidden stream'`,
  ]);

  const result = shredFile(filePath);

  assert.equal(result.success, true);
  assert.equal(fs.existsSync(filePath), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

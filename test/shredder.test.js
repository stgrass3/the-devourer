const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
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

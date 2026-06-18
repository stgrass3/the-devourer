const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DEVOURER_IMPORT_ONLY = '1';

const { app } = require('electron');
const { createTarget, createWindow, validateLoadedWindow } = require('../main');

async function run() {
  await app.whenReady();
  const window = await createWindow({ show: false, smoke: true });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devourer-electron-smoke-'));
  const targetPath = path.join(tempDir, 'ipc-delete-target.bin');
  fs.writeFileSync(targetPath, Buffer.alloc(8 * 1024 * 1024, 0x5a));

  try {
    await validateLoadedWindow(window);
    assert.equal(window.isDestroyed(), false);

    const target = createTarget(targetPath);
    const shredResult = await window.webContents.executeJavaScript(
      `(async () => {
        const target = ${JSON.stringify(target)};
        window.__devourerTest.setTarget(target);
        document.getElementById('bin').dispatchEvent(new MouseEvent('click', { bubbles: true }));

        const deadline = Date.now() + 30_000;
        while (['hungry', 'devouring'].includes(window.__devourerTest.getState())) {
          if (Date.now() > deadline) throw new Error('renderer delete flow timed out');
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        const completed = {
          state: window.__devourerTest.getState(),
          detail: document.getElementById('t-detail').textContent,
          pct: document.getElementById('t-pct').textContent,
        };
        await new Promise((resolve) => setTimeout(resolve, 8_500));
        return {
          completed,
          resetState: window.__devourerTest.getState(),
          resetDetail: document.getElementById('t-detail').textContent,
        };
      })()`,
    );
    assert.equal(shredResult.completed.state, 'done', shredResult.completed.detail);
    assert.equal(shredResult.completed.pct, '100%');
    assert.equal(shredResult.resetState, 'idle', shredResult.resetDetail);
    assert.equal(fs.existsSync(targetPath), false);
    assert.equal(window.isDestroyed(), false);
    console.log('Electron IPC/UI/delete smoke test passed');
  } finally {
    if (!window.isDestroyed()) window.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

run()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

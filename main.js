const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { Worker } = require('worker_threads');
const { pathToFileURL } = require('url');

let mainWindow;
let activeWorker = null;

const targetRegistry = new Map();
const TARGET_TTL_MS = 10 * 60 * 1000;
const SHRED_MODES = new Set(['normal', 'aggressive', 'extreme']);
const STARTUP_SECURE_MODE = parseSecureModeArgument(process.argv);
const IS_SMOKE_TEST = process.argv.includes('--smoke-test');

let administratorCheck;

function parseSecureModeArgument(args) {
  const prefix = '--secure-mode=';
  const value = args.find((arg) => typeof arg === 'string' && arg.startsWith(prefix))?.slice(prefix.length);
  return SHRED_MODES.has(value) ? value : 'normal';
}

function runPowerShell(script) {
  const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand],
      { windowsHide: true },
      (error, stdout) => error ? reject(error) : resolve(stdout.trim()),
    );
  });
}

function appendDiagnostic(eventName, details = {}) {
  if (IS_SMOKE_TEST) return;
  try {
    const line = `${new Date().toISOString()} ${eventName} ${JSON.stringify(details)}\n`;
    fs.appendFileSync(path.join(app.getPath('userData'), 'devourer.log'), line, 'utf8');
  } catch (_) {
    // Diagnostics must never crash the app.
  }
}

function isRunningAsAdministrator() {
  if (process.platform !== 'win32') return Promise.resolve(true);
  if (!administratorCheck) {
    const script = [
      '$identity = [Security.Principal.WindowsIdentity]::GetCurrent()',
      '$principal = [Security.Principal.WindowsPrincipal]::new($identity)',
      '$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    ].join('; ');
    administratorCheck = runPowerShell(script)
      .then((output) => output.toLowerCase() === 'true')
      .catch(() => false);
  }
  return administratorCheck;
}

function quotePowerShellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quoteWindowsArgument(value) {
  const argument = String(value);
  if (argument && !/[\s"]/u.test(argument)) return argument;
  return `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

async function restartAsAdministrator(mode) {
  if (process.platform !== 'win32') throw new Error('administrator restart is only supported on Windows');

  const portableExecutable = process.env.PORTABLE_EXECUTABLE_FILE;
  const executable = portableExecutable || process.execPath;
  const args = [];

  if (process.defaultApp && !portableExecutable) args.push(app.getAppPath());
  if (process.argv.includes('--dev')) args.push('--dev');
  args.push(`--secure-mode=${mode}`);

  const argumentLine = args.map(quoteWindowsArgument).join(' ');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `Start-Process -FilePath ${quotePowerShellLiteral(executable)} -ArgumentList ${quotePowerShellLiteral(argumentLine)} -Verb RunAs`,
  ].join('; ');

  await runPowerShell(script);
}

async function createWindow({ show = true, smoke = false } = {}) {
  mainWindow = new BrowserWindow({
    width: 620,
    height: 520,
    show,
    resizable: false,
    frame: false,
    transparent: true,
    alwaysOnTop: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
  });

  mainWindow.on('unresponsive', () => appendDiagnostic('window-unresponsive'));
  mainWindow.on('close', () => appendDiagnostic('window-close'));
  mainWindow.on('closed', () => appendDiagnostic('window-closed'));
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    appendDiagnostic('render-process-gone', details);
    if (!['clean-exit', 'killed'].includes(details.reason) && !mainWindow.isDestroyed()) {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
      }, 250);
    }
  });

  await mainWindow.loadFile(
    path.join(__dirname, 'index.html'),
    smoke ? { query: { smoke: '1' } } : undefined,
  );
  return mainWindow;
}

async function validateLoadedWindow(window) {
  const preferences = window.webContents.getLastWebPreferences();
  if (!preferences.contextIsolation || preferences.nodeIntegration || !preferences.sandbox) {
    throw new Error('unsafe BrowserWindow webPreferences');
  }

  const result = await window.webContents.executeJavaScript(`
    (async () => {
      const notice = document.getElementById('erase-notice');
      const noticeStyle = notice ? getComputedStyle(notice) : null;
      const apiMethods = [
        'shredFile',
        'getStartupSecureMode',
        'requestSecureMode',
        'pickFile',
        'resolvePath',
        'registerDroppedFile',
        'onProgress',
      ];
      const invalidTarget = await window.devourer.shredFile('__devourer_smoke_invalid_target__');
      return {
        noticeText: notice?.textContent?.trim() || '',
        noticeVisible: Boolean(noticeStyle && noticeStyle.display !== 'none' && noticeStyle.visibility !== 'hidden'),
        modeButtons: document.querySelectorAll('.mode-btn').length,
        apiReady: apiMethods.every((name) => typeof window.devourer?.[name] === 'function'),
        startupMode: await window.devourer.getStartupSecureMode(),
        invalidTarget,
      };
    })()
  `);

  if (!result.noticeVisible || !result.noticeText.includes('BEST-EFFORT ONLY')) {
    throw new Error('pre-delete best-effort warning is missing or hidden');
  }
  if (result.modeButtons !== 3 || !result.apiReady || !SHRED_MODES.has(result.startupMode)) {
    throw new Error('renderer UI or preload API smoke check failed');
  }
  if (result.invalidTarget?.success !== false || !/expired or invalid/i.test(result.invalidTarget?.error || '')) {
    throw new Error('trusted IPC smoke check failed');
  }
}

async function runSmokeTest() {
  const window = await createWindow({ show: false, smoke: true });
  try {
    await validateLoadedWindow(window);
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

function trustedRendererUrl() {
  return pathToFileURL(path.join(__dirname, 'index.html')).href;
}

function assertTrustedSender(event) {
  const senderUrl = event.senderFrame?.url || event.sender?.getURL?.() || '';
  const senderBaseUrl = senderUrl.replace(/[?#].*$/u, '');
  if (senderBaseUrl !== trustedRendererUrl()) {
    throw new Error('untrusted renderer');
  }
}

function pruneTargets() {
  const now = Date.now();
  for (const [id, target] of targetRegistry) {
    if (now - target.createdAt > TARGET_TTL_MS) targetRegistry.delete(id);
  }
}

function createTarget(filePath) {
  pruneTargets();

  const resolvedPath = path.resolve(filePath);
  const stats = fs.statSync(resolvedPath);
  if (!stats.isFile()) throw new Error('target is not a regular file');

  const id = crypto.randomUUID();
  const target = {
    id,
    filePath: resolvedPath,
    name: path.basename(resolvedPath),
    size: stats.size,
    createdAt: Date.now(),
  };

  targetRegistry.set(id, target);
  return publicTarget(target);
}

function takeTarget(id) {
  pruneTargets();
  if (typeof id !== 'string' || !targetRegistry.has(id)) {
    throw new Error('delete target expired or invalid');
  }

  const target = targetRegistry.get(id);
  targetRegistry.delete(id);
  return target;
}

function publicTarget(target) {
  return {
    id: target.id,
    name: target.name,
    size: target.size,
    displayPath: shortPath(target.filePath),
  };
}

function shortPath(filePath) {
  const norm = filePath.replace(/\\/g, '/');
  const parts = norm.split('/').filter(Boolean);
  if (parts.length <= 2) return norm;
  return '.../' + parts.slice(-2).join('/');
}

function normalizeShredRequestOptions(options) {
  const mode = typeof options?.mode === 'string' ? options.mode.toLowerCase() : 'normal';
  return { mode: SHRED_MODES.has(mode) ? mode : 'normal' };
}

function runShredWorker(target, options) {
  if (activeWorker) throw new Error('a file is already being devoured');

  return new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(path.join(__dirname, 'shredder-worker.js'), {
      workerData: { filePath: target.filePath, options: normalizeShredRequestOptions(options) },
    });

    activeWorker = worker;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      activeWorker = null;
      resolve(result);
    };

    worker.on('message', (message) => {
      if (!message || typeof message !== 'object') return;

      if (message.type === 'progress') {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('shred-progress', message.progress);
        }
        return;
      }

      if (message.type === 'done') {
        if (mainWindow && !mainWindow.isDestroyed()) {
          const windowState = {
            visible: mainWindow.isVisible(),
            minimized: mainWindow.isMinimized(),
          };
          appendDiagnostic('delete-complete', windowState);
          if (windowState.minimized) mainWindow.restore();
          if (!windowState.visible) mainWindow.show();
        }
        settle(message.result);
      }
    });

    worker.on('error', (err) => {
      settle({ success: false, error: err.message });
    });

    worker.on('exit', (code) => {
      if (!settled && code !== 0) {
        settle({ success: false, error: `shred worker exited with code ${code}` });
      } else if (!settled) {
        settle({ success: false, error: 'shred worker exited without result' });
      }
    });
  });
}

ipcMain.handle('pick-file', async (event) => {
  assertTrustedSender(event);

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a file to devour',
    properties: ['openFile'],
    filters: [{ name: 'All Files', extensions: ['*'] }],
  });

  if (result.canceled || result.filePaths.length === 0) return null;
  return createTarget(result.filePaths[0]);
});

ipcMain.handle('resolve-path', async (event, filename) => {
  assertTrustedSender(event);

  const result = await dialog.showOpenDialog(mainWindow, {
    title: `Locate "${String(filename || 'file')}" to devour it`,
    properties: ['openFile'],
    filters: [{ name: 'All Files', extensions: ['*'] }],
  });

  if (result.canceled || result.filePaths.length === 0) return null;
  return createTarget(result.filePaths[0]);
});

ipcMain.handle('register-dropped-file', async (event, filePath) => {
  assertTrustedSender(event);
  if (typeof filePath !== 'string' || !filePath.trim()) return null;
  return createTarget(filePath);
});

ipcMain.handle('get-startup-secure-mode', (event) => {
  assertTrustedSender(event);
  return STARTUP_SECURE_MODE;
});

ipcMain.handle('request-secure-mode', async (event, requestedMode) => {
  assertTrustedSender(event);
  const normalizedMode = typeof requestedMode === 'string' ? requestedMode.toLowerCase() : 'normal';
  const mode = SHRED_MODES.has(normalizedMode) ? normalizedMode : 'normal';

  if (mode === 'normal' || await isRunningAsAdministrator()) {
    return { approved: true, mode };
  }

  const operation = mode === 'extreme'
    ? 'ReTrim and free-space wiping both require administrator privileges.'
    : 'ReTrim requires administrator privileges.';
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Administrator access required',
    message: `${mode === 'extreme' ? 'Extreme' : 'Aggressive'} mode requires administrator access`,
    detail: `${operation}\n\nRestart The Devourer as administrator now? You will need to select the file again.`,
    buttons: ['Yes, restart', 'No'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });

  if (result.response !== 0) return { approved: false, mode: STARTUP_SECURE_MODE };

  try {
    await restartAsAdministrator(mode);
    app.quit();
    return { approved: false, restarting: true, mode };
  } catch (error) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Administrator restart failed',
      message: 'The Devourer could not restart as administrator',
      detail: error.message || 'The Windows administrator prompt may have been canceled.',
      buttons: ['OK'],
    });
    return { approved: false, mode: STARTUP_SECURE_MODE };
  }
});

ipcMain.handle('shred-file', async (event, targetId, options) => {
  assertTrustedSender(event);

  try {
    const target = takeTarget(targetId);
    return await runShredWorker(target, options);
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.on('close-window', (event) => {
  assertTrustedSender(event);
  appendDiagnostic('close-window-ipc');
  mainWindow?.close();
});

ipcMain.on('minimize-window', (event) => {
  assertTrustedSender(event);
  appendDiagnostic('minimize-window-ipc');
  mainWindow?.minimize();
});

async function bootApp() {
  await app.whenReady();
  if (IS_SMOKE_TEST) {
    await runSmokeTest();
    app.exit(0);
    return;
  }
  await createWindow();
}

if (process.env.DEVOURER_IMPORT_ONLY !== '1') {
  app.on('child-process-gone', (_event, details) => {
    appendDiagnostic('child-process-gone', details);
  });

  bootApp().catch((error) => {
    console.error('[devourer] startup failed:', error);
    app.exit(1);
  });

  app.on('window-all-closed', () => {
    appendDiagnostic('window-all-closed');
    app.quit();
  });

  app.on('before-quit', () => appendDiagnostic('before-quit'));
  app.on('will-quit', () => appendDiagnostic('will-quit'));
}

module.exports = {
  createTarget,
  createWindow,
  validateLoadedWindow,
};

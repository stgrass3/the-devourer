const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const CHUNK = 1024 * 1024;
const DATA_PROGRESS_START = 0.30;
const DATA_PROGRESS_END = 0.78;
const FREE_SPACE_PROGRESS_START = 0.91;
const FREE_SPACE_PROGRESS_END = 0.98;
const FREE_SPACE_RESERVE_BYTES = 512 * 1024 * 1024;
const IS_WIN = process.platform === 'win32';
const ENV_ENABLE_RETRIM = process.env.DEVOURER_ENABLE_RETRIM === '1';
const ENV_ENABLE_FREE_SPACE_WIPE = process.env.DEVOURER_FREE_SPACE_WIPE === '1';
const SHRED_MODE_PRESETS = Object.freeze({
  normal: { enableRetrim: false, enableFreeSpaceWipe: false },
  aggressive: { enableRetrim: true, enableFreeSpaceWipe: false },
  extreme: { enableRetrim: true, enableFreeSpaceWipe: true },
});
const storageRiskCache = new Map();
const shadowCopyCache = new Map();

function normalizeShredOptions(options = {}) {
  const requestedMode = typeof options.mode === 'string' ? options.mode.toLowerCase() : 'normal';
  const mode = Object.hasOwn(SHRED_MODE_PRESETS, requestedMode) ? requestedMode : 'normal';
  const preset = SHRED_MODE_PRESETS[mode];

  return {
    mode,
    enableRetrim: Boolean(ENV_ENABLE_RETRIM || preset.enableRetrim || options.enableRetrim),
    enableFreeSpaceWipe: Boolean(
      ENV_ENABLE_FREE_SPACE_WIPE ||
      preset.enableFreeSpaceWipe ||
      options.enableFreeSpaceWipe
    ),
  };
}

function psEscape(s) {
  return String(s).replace(/'/g, "''");
}

function runPowerShell(script, opts = {}) {
  return execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      windowsHide: true,
      timeout: opts.timeout || 8000,
      encoding: opts.encoding || 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
}

function runCommandText(command, args, opts = {}) {
  return execFileSync(command, args, {
    windowsHide: true,
    timeout: opts.timeout || 2500,
    encoding: opts.encoding || 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function shortCommandFailure(err) {
  if (err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM') return 'timed out';
  if (Number.isInteger(err.status)) return `exit ${err.status}`;
  return String(err.message || 'unknown error').split(/\r?\n/)[0];
}

function randomName() {
  return crypto.randomBytes(32).toString('hex');
}

function uniquePath(dir) {
  for (let i = 0; i < 20; i++) {
    const candidate = path.join(dir, randomName());
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error('failed to allocate random shred name');
}

function driveRootFor(filePath) {
  return path.parse(path.resolve(filePath)).root;
}

function driveLetterFor(filePath) {
  const root = driveRootFor(filePath);
  const match = root.match(/^([A-Za-z]):\\/);
  return match ? match[1].toUpperCase() : null;
}

function hasWindowsReparsePoint(filePath) {
  if (!IS_WIN) return false;

  try {
    const out = runPowerShell(
      `$item=Get-Item -LiteralPath '${psEscape(filePath)}' -Force;` +
      `if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { '1' } else { '0' }`
    ).trim();
    return out === '1';
  } catch (_) {
    return false;
  }
}

function inspectTarget(filePath) {
  const linkStats = fs.lstatSync(filePath);

  if (linkStats.isSymbolicLink()) {
    throw new Error('target is a symbolic link; refusing to shred link targets');
  }

  if (hasWindowsReparsePoint(filePath)) {
    throw new Error('target is a reparse point; refusing unsafe namespace target');
  }

  const stats = fs.statSync(filePath);
  if (!stats.isFile()) throw new Error('target is not a regular file');

  if (stats.nlink > 1) {
    throw new Error(`target has ${stats.nlink} hard links; remove other links before shredding`);
  }

  return stats;
}

function assertExclusiveAccess(filePath) {
  if (!IS_WIN) return;

  try {
    runPowerShell(
      `$fs=[System.IO.File]::Open('${psEscape(filePath)}',` +
      `[System.IO.FileMode]::Open,` +
      `[System.IO.FileAccess]::ReadWrite,` +
      `[System.IO.FileShare]::None);` +
      `$fs.Close()`
    );
  } catch (err) {
    throw new Error(`target is locked by another process: ${err.message}`);
  }
}

function detectStorageRisk(filePath) {
  if (!IS_WIN) return { warnings: [], mediaType: null };

  try {
    const driveLetter = driveLetterFor(filePath);
    if (!driveLetter) return { warnings: ['storage risk detection skipped: unknown drive'], mediaType: null };
    if (storageRiskCache.has(driveLetter)) return storageRiskCache.get(driveLetter);

    const warnings = [];
    let mediaType = '';
    let busType = '';

    try {
      const out = runPowerShell(
        `$drive='${driveLetter}';` +
        `$media=$null;$bus=$null;` +
        `try { $p=Get-Partition -DriveLetter $drive -ErrorAction Stop | Select-Object -First 1;` +
        `$d=Get-Disk -Number $p.DiskNumber -ErrorAction Stop;` +
        `$media=[string]$d.MediaType;$bus=[string]$d.BusType } catch {}` +
        `[pscustomobject]@{Drive=$drive;MediaType=$media;BusType=$bus} | ConvertTo-Json -Compress`,
        { timeout: 3500 }
      ).trim();
      if (out) {
        const info = JSON.parse(out);
        mediaType = String(info.MediaType || '').toLowerCase();
        busType = String(info.BusType || '').toLowerCase();
      }
    } catch (err) {
      warnings.push(`storage media detection unavailable (${shortCommandFailure(err)})`);
    }

    const flashLike = mediaType.includes('ssd') || busType.includes('nvme');
    if (flashLike) {
      warnings.push('SSD detected: overwrite is best-effort because wear leveling can keep old cells');
    } else if (!mediaType || mediaType.includes('unspecified')) {
      warnings.push('storage media type unknown: overwrite reliability cannot be verified');
    }

    try {
      const trimOut = runCommandText(
        'fsutil',
        ['behavior', 'query', 'DisableDeleteNotify'],
        { timeout: 1500 }
      );
      if (!flashLike && /=\s*0\b/.test(trimOut)) {
        warnings.push('TRIM is enabled: remapped flash storage may not expose old cells to overwrite');
      }
    } catch (err) {
      warnings.push(`TRIM status unavailable (${shortCommandFailure(err)})`);
    }

    try {
      const bdeOut = runCommandText(
        'manage-bde',
        ['-status', `${driveLetter}:`],
        { timeout: 1500 }
      );
      const protectionOn = /Protection Status:\s+Protection On/i.test(bdeOut);
      const fullyEncrypted = /Conversion Status:\s+Fully Encrypted/i.test(bdeOut)
        || /Percentage Encrypted:\s+100(?:\.0)?%/i.test(bdeOut);
      if (!protectionOn || !fullyEncrypted) {
        warnings.push('BitLocker full-volume protection is not confirmed');
      }
    } catch (err) {
      warnings.push(`BitLocker status unavailable (${shortCommandFailure(err)}): full-disk encryption not verified`);
    }

    const result = { warnings, mediaType };
    storageRiskCache.set(driveLetter, result);
    return result;
  } catch (err) {
    return { warnings: [`storage risk detection failed: ${err.message}`], mediaType: null };
  }
}

function detectShadowCopies(filePath) {
  if (!IS_WIN) return { warnings: [], count: 0 };

  try {
    const driveLetter = driveLetterFor(filePath);
    if (!driveLetter) return { warnings: ['shadow copy detection skipped: unknown drive'], count: 0 };
    if (shadowCopyCache.has(driveLetter)) return shadowCopyCache.get(driveLetter);

    const out = runCommandText(
      'vssadmin',
      ['list', 'shadows', `/for=${driveLetter}:`],
      { timeout: 2500 }
    );
    const count = (out.match(/Shadow Copy ID:/gi) || []).length;
    const result = {
      count,
      warnings: count > 0
        ? [`${count} Volume Shadow Copy snapshot(s) may retain older file data`]
        : [],
    };
    shadowCopyCache.set(driveLetter, result);
    return result;
  } catch (err) {
    return {
      warnings: [`shadow copy status unavailable (${shortCommandFailure(err)}): old versions may exist in restore snapshots`],
      count: 0,
    };
  }
}

function setNormalAttributes(filePath) {
  try {
    runPowerShell(`Set-ItemProperty -LiteralPath '${psEscape(filePath)}' -Name Attributes -Value 'Normal'`);
    return;
  } catch (_) {
    try {
      fs.chmodSync(filePath, 0o666);
      return;
    } catch (err) {
      throw new Error(`failed to clear file attributes: ${err.message}`);
    }
  }
}

function wipeTimestamps(filePath) {
  try {
    runPowerShell(
      `$f=Get-Item -LiteralPath '${psEscape(filePath)}';` +
      `$f.CreationTime='1970-01-01T00:00:00Z';` +
      `$f.LastWriteTime='1970-01-01T00:00:00Z';` +
      `$f.LastAccessTime='1970-01-01T00:00:00Z'`
    );
    return true;
  } catch (_) {
    try {
      fs.utimesSync(filePath, 0, 0);
      return false;
    } catch (err) {
      throw new Error(`failed to wipe timestamps: ${err.message}`);
    }
  }
}

function enumerateStreams(filePath) {
  try {
    const psOut = runPowerShell(
      `$items=Get-Item -LiteralPath '${psEscape(filePath)}' -Stream * | ` +
      `Select-Object Stream,Length;` +
      `if ($items) { $items | ConvertTo-Json -Compress }`
    ).trim();

    if (!psOut) return [];

    const parsed = JSON.parse(psOut);
    const items = Array.isArray(parsed) ? parsed : [parsed];

    return items
      .map((item) => ({
        name: String(item.Stream || '').trim(),
        size: Number.isFinite(Number(item.Length)) ? Number(item.Length) : 0,
      }))
      .filter((stream) => {
        const upper = stream.name.toUpperCase();
        return stream.name && upper !== ':$DATA' && upper !== '$DATA';
      });
  } catch (err) {
    throw new Error(`failed to enumerate alternate data streams: ${err.message}`);
  }
}

function removeStream(filePath, streamName) {
  runPowerShell(`Remove-Item -LiteralPath '${psEscape(filePath)}' -Stream '${psEscape(streamName)}' -ErrorAction Stop`);
}

function cleanupWindowsArtifacts(paths) {
  if (!IS_WIN) return [];

  const escaped = paths
    .filter(Boolean)
    .map((p) => `'${psEscape(path.resolve(p))}'`)
    .join(',');

  if (!escaped) return [];

  try {
    runPowerShell(
      `$targets=@(${escaped});` +
      `$recent=[Environment]::GetFolderPath('Recent');` +
      `if ($recent -and (Test-Path -LiteralPath $recent)) {` +
      `  $ws=New-Object -ComObject WScript.Shell;` +
      `  Get-ChildItem -LiteralPath $recent -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | ForEach-Object {` +
      `    try { $s=$ws.CreateShortcut($_.FullName);` +
      `      if ($targets -contains $s.TargetPath) { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop }` +
      `    } catch {}` +
      `  }` +
      `}`,
      { timeout: 12000 }
    );
    return [];
  } catch (err) {
    return [`recent-file artifact cleanup failed: ${err.message}`];
  }
}

function retrimVolume(filePath, enabled) {
  if (!IS_WIN) return [];
  if (!enabled) return [];

  const driveLetter = driveLetterFor(filePath);
  if (!driveLetter) return ['retrim skipped: unknown drive'];

  try {
    runPowerShell(`Optimize-Volume -DriveLetter '${driveLetter}' -ReTrim -ErrorAction Stop | Out-Null`, { timeout: 60000 });
    return [];
  } catch (err) {
    return [`retrim failed (${shortCommandFailure(err)}): administrator permission may be required`];
  }
}

function getFreeBytes(dir) {
  if (typeof fs.statfsSync !== 'function') return 0;

  try {
    const stat = fs.statfsSync(dir);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch (_) {
    return 0;
  }
}

function wipeFreeSpace(dir, onProgress, enabled) {
  if (!enabled) return [];

  const baseFree = getFreeBytes(dir);
  if (baseFree <= FREE_SPACE_RESERVE_BYTES) return ['free-space wipe skipped: not enough free space above reserve'];

  const wipeDir = `${uniquePath(dir)}.freewipe`;
  fs.mkdirSync(wipeDir, { recursive: false });

  const filler = Buffer.alloc(CHUNK);
  const targetBytes = Math.max(0, baseFree - FREE_SPACE_RESERVE_BYTES);
  let writtenTotal = 0;
  let fileIndex = 0;

  try {
    while (writtenTotal < targetBytes) {
      const freeNow = getFreeBytes(dir);
      if (freeNow > 0 && freeNow <= FREE_SPACE_RESERVE_BYTES) break;

      const fillerPath = path.join(wipeDir, randomName());
      const fd = fs.openSync(fillerPath, 'wx');
      try {
        let fileWritten = 0;
        while (fileWritten < 256 * CHUNK && writtenTotal < targetBytes) {
          crypto.randomFillSync(filler);
          const remaining = targetBytes - writtenTotal;
          const chunkSize = Math.min(CHUNK, remaining);
          fs.writeSync(fd, filler, 0, chunkSize);
          fileWritten += chunkSize;
          writtenTotal += chunkSize;

          if (typeof onProgress === 'function') {
            const ratio = Math.max(0, Math.min(1, writtenTotal / targetBytes));
            onProgress(FREE_SPACE_PROGRESS_START + (FREE_SPACE_PROGRESS_END - FREE_SPACE_PROGRESS_START) * ratio);
          }
        }
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }

      fileIndex += 1;
      if (fileIndex > 100000) throw new Error('free-space wipe exceeded safety file count');
    }

    return [];
  } catch (err) {
    return [`free-space wipe stopped: ${err.message}`];
  } finally {
    fs.rmSync(wipeDir, { recursive: true, force: true });
  }
}

function progressFromBytes(done, total) {
  if (total <= 0) return DATA_PROGRESS_END;
  const ratio = Math.max(0, Math.min(1, done / total));
  return DATA_PROGRESS_START + (DATA_PROGRESS_END - DATA_PROGRESS_START) * ratio;
}

function shredFile(filePath, onProgress, options = {}) {
  const shredOptions = normalizeShredOptions(options);
  const originalName = path.basename(filePath);
  const originalPath = path.resolve(filePath);
  const originalDir = path.dirname(originalPath);
  let fd = null;
  let shreddedPath = filePath;
  let bytesDone = 0;
  let bytesTotal = 0;
  let mainSize = 0;
  const warnings = [];

  const emit = (pct, phase, detail) => {
    if (typeof onProgress === 'function') {
      onProgress({
        pct,
        phase,
        detail,
        bytesDone,
        bytesTotal,
      });
    }
  };

  const emitData = (phase, detail) => {
    emit(progressFromBytes(bytesDone, bytesTotal), phase, detail);
  };

  try {
    emit(0.02, 'INSPECT', 'target acquired');
    const stats = inspectTarget(filePath);
    mainSize = stats.size;

    emit(0.05, 'LINK GUARD', 'rejecting links and reparse points');
    emit(0.08, 'MEDIA RISK', 'SSD and BitLocker check');
    warnings.push(...detectStorageRisk(filePath).warnings);

    emit(0.11, 'VSS CHECK', 'shadow copy scan');
    warnings.push(...detectShadowCopies(filePath).warnings);

    emit(0.14, 'STRIP ATTRS', 'clearing blocking flags');
    setNormalAttributes(filePath);

    emit(0.16, 'LOCK CHECK', 'exclusive write probe');
    assertExclusiveAccess(filePath);

    emit(0.18, 'ENUM ADS', 'scanning hidden streams');
    const streams = enumerateStreams(filePath);
    bytesTotal = (mainSize * 4) + streams.reduce((sum, stream) => sum + (stream.size * 4), 0);
    emit(0.22, 'ADS MAP', streams.length ? `${streams.length} stream${streams.length > 1 ? 's' : ''} found` : 'no named streams');

    for (const stream of streams) {
      shredNamedStream(filePath, stream, emitData, (written) => {
        bytesDone += written;
      });

      try {
        removeStream(filePath, stream.name);
      } catch (err) {
        warnings.push(`stream "${stream.name}" was wiped but could not be removed: ${err.message}`);
      }
    }

    emit(0.25, 'RENAME LOCAL', 'original name detached');
    shreddedPath = uniquePath(path.dirname(filePath));
    fs.renameSync(filePath, shreddedPath);

    try {
      if (!wipeTimestamps(shreddedPath)) warnings.push('creation timestamp wipe fell back to atime/mtime only');
    } catch (err) {
      warnings.push(err.message);
    }

    emit(0.28, 'RELOCATE %TEMP%', 'random temp namespace');
    try {
      const tempPath = uniquePath(os.tmpdir());
      fs.renameSync(shreddedPath, tempPath);
      shreddedPath = tempPath;
    } catch (_) {
      warnings.push('temp relocation failed; continuing with randomized local name');
    }

    emit(0.30, 'OPEN DATA', 'write handle acquired');
    fd = fs.openSync(shreddedPath, 'r+');

    if (mainSize > 0) {
      shredOpenHandle(fd, mainSize, 'DATA', emitData, (written) => {
        bytesDone += written;
      });
    }

    emit(0.82, 'TRUNC DATA', '$DATA length = 0');
    fs.ftruncateSync(fd, 0);

    emit(0.84, 'WIPE TIMES', 'creation write access = epoch');
    if (!wipeTimestamps(shreddedPath)) warnings.push('creation timestamp wipe fell back to atime/mtime only');

    emit(0.86, 'FINAL FLUSH', 'metadata flush');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    fs.unlinkSync(shreddedPath);

    emit(0.89, 'ARTIFACTS', 'recent-file traces cleanup');
    warnings.push(...cleanupWindowsArtifacts([originalPath, shreddedPath]));

    emit(0.91, 'RETRIM', shredOptions.enableRetrim ? 'volume retrim' : 'not selected in this mode');
    warnings.push(...retrimVolume(originalPath, shredOptions.enableRetrim));

    emit(0.93, 'FREE SPACE', shredOptions.enableFreeSpaceWipe ? 'same-volume free-space wipe' : 'not selected in this mode');
    warnings.push(...wipeFreeSpace(originalDir, (pct) => {
      emit(pct, 'FREE SPACE', 'same-volume filler wipe');
    }, shredOptions.enableFreeSpaceWipe));

    emit(1.00, 'EVAPORATE', warnings.length ? 'deleted with best-effort warnings' : 'namespace unlinked');

    return { success: true, name: originalName, size: mainSize, warnings, mode: shredOptions.mode };
  } catch (err) {
    try {
      if (fd !== null) fs.closeSync(fd);
    } catch (_) {
      // Original error is more useful than emergency close failure.
    }
    throw err;
  }
}

function shredNamedStream(filePath, stream, onProgress, onBytes) {
  let adsFd = null;
  const adsPath = `${filePath}:${stream.name}`;

  try {
    if (stream.size > 0) {
      adsFd = fs.openSync(adsPath, 'r+');
      shredOpenHandle(adsFd, stream.size, `ADS ${stream.name}`, onProgress, onBytes);
      fs.ftruncateSync(adsFd, 0);
      fs.fsyncSync(adsFd);
    }
  } catch (err) {
    throw new Error(`failed to shred ADS "${stream.name}": ${err.message}`);
  } finally {
    if (adsFd !== null) {
      try {
        fs.closeSync(adsFd);
      } catch (_) {
        // Ignore close failure after failed stream wipe.
      }
    }
  }
}

function shredOpenHandle(fd, fileSize, label, onProgress, onBytes) {
  const passes = [
    { phase: `${label} 1/4 ZERO`, detail: '0x00 fill  fsync', fill: 0x00 },
    { phase: `${label} 2/4 ONES`, detail: '0xFF fill  fsync', fill: 0xFF },
    { phase: `${label} 3/4 RNG`, detail: 'fresh CSPRNG chunks  fsync', random: true },
    { phase: `${label} 4/4 ZERO`, detail: 'final zero fill  fsync', fill: 0x00 },
  ];

  for (const pass of passes) {
    if (typeof onProgress === 'function') onProgress(pass.phase, pass.detail);

    if (pass.random) {
      writeRandomPass(fd, fileSize, onBytes);
    } else {
      writeFillPass(fd, pass.fill, fileSize, onBytes);
    }

    fs.fsyncSync(fd);
  }
}

function writeFillPass(fd, fill, fileSize, onBytes) {
  const patternBuf = Buffer.alloc(CHUNK, fill);
  let remaining = fileSize;
  let offset = 0;

  while (remaining > 0) {
    const chunkSize = Math.min(remaining, patternBuf.length);
    writeAll(fd, patternBuf, chunkSize, offset, onBytes);
    offset += chunkSize;
    remaining -= chunkSize;
  }
}

function writeRandomPass(fd, fileSize, onBytes) {
  let remaining = fileSize;
  let offset = 0;

  while (remaining > 0) {
    const chunkSize = Math.min(remaining, CHUNK);
    const randomBuf = crypto.randomBytes(chunkSize);
    writeAll(fd, randomBuf, chunkSize, offset, onBytes);
    offset += chunkSize;
    remaining -= chunkSize;
  }
}

function writeAll(fd, buf, chunkSize, offset, onBytes) {
  let written = 0;

  while (written < chunkSize) {
    const n = fs.writeSync(fd, buf, written, chunkSize - written, offset + written);
    if (n === 0) throw new Error('writeSync returned 0 - disk full or I/O error');
    written += n;
    if (typeof onBytes === 'function') onBytes(n);
  }
}

module.exports = {
  enumerateStreams,
  shredFile,
};

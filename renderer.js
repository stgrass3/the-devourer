const stage = document.getElementById('stage');
const bin = document.getElementById('bin');
const terminalEl = document.getElementById('terminal');

const tPhase = document.getElementById('t-phase');
const tTarget = document.getElementById('t-target');
const tDetail = document.getElementById('t-detail');
const tPct = document.getElementById('t-pct');
const tBytes = document.getElementById('t-bytes');
const tFill = document.getElementById('t-fill');
const modePanel = document.getElementById('mode-panel');
const modeButtons = Array.from(document.querySelectorAll('.mode-btn'));
const modeNote = document.getElementById('mode-note');
const warningPanel = document.getElementById('warning-panel');
const warningList = document.getElementById('warning-list');

let state = 'idle'; // idle | hungry | devouring | done | error
let currentTargetId = null;
let currentFileName = null;
let currentFileSize = 0;
let currentDisplayPath = null;
let secureMode = 'normal';
let secureModeRequestPending = false;
let progressBytesDone = 0;
let progressBytesTotal = 0;
let dragDepth = 0;
let unsubProgress = null;

const lidEl = document.getElementById('lid');
let lidAnim = null;

const MODE_COPY = {
  normal: '4-pass wipe',
  aggressive: '4-pass wipe + ReTrim',
  extreme: '4-pass wipe + ReTrim + free-space wipe',
};

const PHASE_COPY = {
  INSPECT: ['CHECK TARGET', 'verifying file shape'],
  'LINK GUARD': ['LINK GUARD', 'rejecting links and reparse points'],
  'MEDIA RISK': ['RISK SCAN', 'checking SSD, TRIM, and BitLocker'],
  'VSS CHECK': ['SNAPSHOT SCAN', 'checking Windows Shadow Copies'],
  'STRIP ATTRS': ['UNLOCK FLAGS', 'clearing blocking file attributes'],
  'LOCK CHECK': ['LOCK CHECK', 'probing exclusive write access'],
  'ENUM ADS': ['ADS SCAN', 'scanning hidden NTFS streams'],
  'ADS MAP': ['ADS MAP', null],
  'RENAME LOCAL': ['RANDOMIZE NAME', 'detaching original filename'],
  'RELOCATE %TEMP%': ['TEMP MOVE', 'moving into random temp namespace'],
  'OPEN DATA': ['OPEN HANDLE', 'write handle acquired'],
  'TRUNC DATA': ['TRUNCATE', 'setting file length to zero'],
  'WIPE TIMES': ['TIMESTAMP WIPE', 'resetting file timestamps'],
  'FINAL FLUSH': ['FINAL FLUSH', 'forcing metadata to disk'],
  ARTIFACTS: ['TRACE CLEANUP', 'removing recent-file shortcuts'],
  RETRIM: ['RETRIM', null],
  'FREE SPACE': ['FREE SPACE', null],
  EVAPORATE: ['COMPLETE', null],
};

function formatProgressCopy(phase, detail) {
  if (!phase) return { phase, detail };

  const dataPass = phase.match(/^DATA (\d)\/4 (ZERO|ONES|RNG)$/);
  if (dataPass) {
    const passDetail = {
      ZERO: dataPass[1] === '1' ? 'overwriting with zeroes' : 'final zero overwrite',
      ONES: 'overwriting with ones',
      RNG: 'overwriting with cryptographic random bytes',
    };
    return { phase: `PASS ${dataPass[1]}/4`, detail: passDetail[dataPass[2]] };
  }

  if (phase.startsWith('ADS ')) {
    return { phase: 'ADS WIPE', detail: detail || 'overwriting hidden stream' };
  }

  const copy = PHASE_COPY[phase];
  if (!copy) return { phase, detail };
  return { phase: copy[0], detail: copy[1] || detail };
}

function setMonsterMode(mode) {
  if (window.devourerMonster?.setMode) window.devourerMonster.setMode(mode);
}

function setMonsterProgress(pct) {
  if (window.devourerMonster?.setProgress) window.devourerMonster.setProgress(pct);
}

function currentLidDeg() {
  if (!lidEl) return 0;
  const cs = getComputedStyle(lidEl);
  if (!cs.transform || cs.transform === 'none') return 0;
  const m = cs.transform.match(/matrix\(([^)]+)\)/);
  if (!m) return 0;
  const parts = m[1].split(',').map(parseFloat);
  if (parts.length !== 6) return 0;
  return Math.atan2(parts[1], parts[0]) * 180 / Math.PI;
}

const LID_PRESETS = {
  idle: {
    dur: 360,
    frames: (from) => [
      { transform: `rotate(${from}deg)`, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' },
      { transform: 'rotate(0deg)' },
    ],
  },
  hover: {
    dur: 360,
    frames: (from) => [
      { transform: `rotate(${from}deg)`, easing: 'cubic-bezier(0.2, 0.9, 0.2, 1)' },
      { transform: 'rotate(-4deg)' },
    ],
  },
  dragover: {
    dur: 320,
    frames: (from) => [
      { transform: `rotate(${from}deg)`, easing: 'cubic-bezier(0.2, 0.9, 0.2, 1)' },
      { transform: 'rotate(-9deg)' },
    ],
  },
  hungry: {
    dur: 560,
    frames: (from) => [
      { transform: `rotate(${from}deg)`, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
      { transform: 'rotate(-1deg)', offset: 0.16, easing: 'cubic-bezier(0.3, 0, 0.2, 1)' },
      { transform: 'rotate(-12deg)', offset: 0.72 },
      { transform: 'rotate(-10deg)' },
    ],
  },
  devour: {
    dur: 720,
    frames: (from) => [
      { transform: `rotate(${from}deg)`, easing: 'cubic-bezier(0.62, 0, 0.34, 1)' },
      { transform: 'rotate(-18deg)', offset: 0.18, easing: 'cubic-bezier(0.7, 0, 0.5, 1)' },
      { transform: 'rotate(-34deg)', offset: 0.58, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
      { transform: 'rotate(-31deg)' },
    ],
  },
  done: {
    dur: 620,
    frames: (from) => [
      { transform: `rotate(${from}deg)`, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' },
      { transform: 'rotate(-4deg)', offset: 0.42, easing: 'cubic-bezier(0.34, 1.2, 0.64, 1)' },
      { transform: 'rotate(1.5deg)', offset: 0.78 },
      { transform: 'rotate(0deg)' },
    ],
  },
  error: {
    dur: 240,
    frames: (from) => [
      { transform: `rotate(${from}deg)`, easing: 'cubic-bezier(0.55, 0, 0.4, 1)' },
      { transform: 'rotate(8deg)', offset: 0.48 },
      { transform: 'rotate(0deg)' },
    ],
  },
};

function setLid(presetName) {
  const preset = LID_PRESETS[presetName];
  if (!preset || !lidEl) return;
  if (lidAnim) {
    try { lidAnim.cancel(); } catch (_) {}
  }

  const from = currentLidDeg();
  lidAnim = lidEl.animate(preset.frames(from), {
    duration: preset.dur,
    fill: 'forwards',
  });
}

function playBinClick() {
  bin.classList.remove('is-clicking');
  void bin.offsetWidth;
  bin.classList.add('is-clicking');
  if (window.devourerMonster?.poke) window.devourerMonster.poke();
  setTimeout(() => bin.classList.remove('is-clicking'), 280);
}

function fmtBytes(n) {
  if (!n || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2) + ' ' + units[i];
}

function applySecureMode(mode) {
  if (!MODE_COPY[mode] || state === 'devouring') return;
  secureMode = mode;

  for (const button of modeButtons) {
    const active = button.dataset.mode === mode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }

  if (modeNote) modeNote.textContent = MODE_COPY[mode];
}

async function requestSecureMode(mode) {
  if (!MODE_COPY[mode] || mode === secureMode || state === 'devouring' || secureModeRequestPending) return;

  secureModeRequestPending = true;
  setModeLocked(true);
  try {
    const result = await devourer.requestSecureMode(mode);
    if (result?.approved) applySecureMode(result.mode);
  } catch (error) {
    console.error('[devourer] secure mode request failed', error);
  } finally {
    secureModeRequestPending = false;
    if (state !== 'devouring') setModeLocked(false);
  }
}

function setModeLocked(locked) {
  if (modePanel) modePanel.classList.toggle('is-locked', locked);
  for (const button of modeButtons) button.disabled = locked;
}

function clearWarnings() {
  if (warningPanel) warningPanel.hidden = true;
  if (warningList) warningList.replaceChildren();
}

function renderWarnings(warnings) {
  clearWarnings();
  if (!warningPanel || !warningList || !Array.isArray(warnings) || warnings.length === 0) return;

  for (const warning of warnings.slice(0, 5)) {
    const item = document.createElement('li');
    item.textContent = warning;
    warningList.appendChild(item);
  }

  if (warnings.length > 5) {
    const item = document.createElement('li');
    item.textContent = `${warnings.length - 5} more warning${warnings.length - 5 === 1 ? '' : 's'}`;
    warningList.appendChild(item);
  }

  warningPanel.hidden = false;
}

function setHud(pct, phase, detail, bytesDone, bytesTotal) {
  if (!terminalEl) return;
  const progressCopy = formatProgressCopy(phase, detail);
  if (progressCopy.phase) tPhase.textContent = progressCopy.phase;
  if (progressCopy.detail) tDetail.textContent = progressCopy.detail;
  if (Number.isFinite(bytesDone)) progressBytesDone = bytesDone;
  if (Number.isFinite(bytesTotal)) progressBytesTotal = bytesTotal;

  if (typeof pct === 'number') {
    setMonsterProgress(pct);
    const pctNum = Math.max(0, Math.min(100, Math.round(pct * 100)));
    tPct.textContent = `${pctNum}%`;
    tFill.style.width = `${pctNum}%`;

    if (progressBytesTotal > 0) {
      const done = Math.min(progressBytesDone, progressBytesTotal);
      tBytes.textContent = `${fmtBytes(done)} / ${fmtBytes(progressBytesTotal)}`;
    } else {
      tBytes.textContent = '0 B';
    }
  }
}

function resetHud() {
  if (!terminalEl) return;
  tPhase.textContent = 'DEVOUR';
  tTarget.textContent = '--';
  tDetail.textContent = 'awaiting target';
  tPct.textContent = '0%';
  tBytes.textContent = '0 B';
  tFill.style.width = '0%';
  progressBytesDone = 0;
  progressBytesTotal = 0;
}

function clearStateClasses() {
  stage.classList.remove('state-hungry', 'state-devouring', 'state-done', 'state-error');
}

function shortPath(p) {
  if (!p) return '--';
  const norm = p.replace(/\\/g, '/');
  const parts = norm.split('/').filter(Boolean);
  if (parts.length === 0) return norm;
  if (parts.length === 1) return parts[0];
  return '.../' + parts.slice(-2).join('/');
}

function setHungry() {
  state = 'hungry';
  clearStateClasses();
  stage.classList.add('state-hungry');
  setLid('hungry');
  setMonsterMode('hungry');
  tPhase.textContent = 'ARMED';
  tTarget.textContent = shortPath(currentDisplayPath || currentFileName);
  tDetail.textContent = `PERMANENT DELETE  ${secureMode.toUpperCase()} MODE`;
  tPct.textContent = '0%';
  tBytes.textContent = '0 B';
  tFill.style.width = '0%';
  progressBytesDone = 0;
  progressBytesTotal = 0;
}

function resetUI() {
  if (unsubProgress) {
    unsubProgress();
    unsubProgress = null;
  }
  state = 'idle';
  currentTargetId = null;
  currentFileName = null;
  currentFileSize = 0;
  currentDisplayPath = null;
  clearStateClasses();
  resetHud();
  setLid('idle');
  setMonsterProgress(0);
  setMonsterMode('idle');
  setModeLocked(false);
  clearWarnings();
}

function showError(msg) {
  state = 'error';
  clearStateClasses();
  stage.classList.add('state-error');
  setLid('error');
  setMonsterMode('error');
  if (unsubProgress) {
    unsubProgress();
    unsubProgress = null;
  }
  tDetail.textContent = 'ERROR  ' + msg.toUpperCase().slice(0, 40);
  console.error('[devourer]', msg);
  setModeLocked(false);
  clearWarnings();
  setTimeout(resetUI, 1400);
}

async function startDevour() {
  if (!currentTargetId || state === 'devouring') return;

  state = 'devouring';
  clearStateClasses();
  stage.classList.add('state-devouring');
  setLid('devour');
  setMonsterProgress(0);
  setMonsterMode('devouring');
  setModeLocked(true);
  clearWarnings();

  if (unsubProgress) unsubProgress();
  progressBytesDone = 0;
  progressBytesTotal = 0;

  unsubProgress = devourer.onProgress((p) => {
    setHud(p.pct, p.phase, p.detail, p.bytesDone, p.bytesTotal);
  });

  setHud(0, 'INIT', 'opening target');

  try {
    const result = await devourer.shredFile(currentTargetId, { mode: secureMode });
    if (unsubProgress) {
      unsubProgress();
      unsubProgress = null;
    }

    if (!result.success) throw new Error(result.error || 'Unknown error');

    const warnings = Array.isArray(result.warnings) ? result.warnings.length : 0;
    tDetail.textContent = warnings
      ? `deleted  best-effort warnings: ${warnings}`
      : 'namespace unlinked  streams wiped';
    renderWarnings(result.warnings);
    tFill.style.width = '100%';
    tPct.textContent = '100%';
    tBytes.textContent = progressBytesTotal > 0
      ? `${fmtBytes(progressBytesTotal)} / ${fmtBytes(progressBytesTotal)}`
      : '0 B';
    state = 'done';
    stage.classList.remove('state-devouring');
    stage.classList.add('state-done');
    setLid('done');
    setMonsterProgress(1);
    setMonsterMode('done');
    setTimeout(resetUI, warnings ? 7600 : 3200);
  } catch (err) {
    if (unsubProgress) {
      unsubProgress();
      unsubProgress = null;
    }
    showError(err.message);
  }
}

document.getElementById('btn-min')
  .addEventListener('click', () => devourer.minimizeWindow());

document.getElementById('btn-close')
  .addEventListener('click', () => devourer.closeWindow());

for (const button of modeButtons) {
  button.addEventListener('click', () => requestSecureMode(button.dataset.mode));
}

applySecureMode(secureMode);
devourer.getStartupSecureMode()
  .then((mode) => applySecureMode(mode))
  .catch(() => applySecureMode('normal'));

function setTarget(file) {
  currentTargetId = file.id;
  currentFileName = file.name;
  currentFileSize = file.size || 0;
  currentDisplayPath = file.displayPath || file.name;
  setHungry();
}

if (new URLSearchParams(window.location.search).has('smoke')) {
  Object.defineProperty(window, '__devourerTest', {
    value: Object.freeze({
      getState: () => state,
      setTarget,
    }),
  });
}

bin.addEventListener('mouseenter', () => {
  if (state === 'idle') {
    setLid('hover');
    setMonsterMode('hover');
  }
});

bin.addEventListener('mouseleave', () => {
  if (state === 'idle') {
    setLid('idle');
    setMonsterMode('idle');
  }
});

bin.addEventListener('click', async () => {
  try {
    if (state === 'devouring') return;

    if (state === 'done' || state === 'error') {
      resetUI();
      return;
    }

    if (state === 'hungry') {
      playBinClick();
      startDevour();
      return;
    }

    playBinClick();
    const file = await devourer.pickFile();
    if (!file) return;
    setTarget(file);
  } catch (err) {
    showError(err.message);
  }
});

document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  if (state !== 'devouring') {
    stage.classList.add('dragover');
    setLid('dragover');
    setMonsterMode('hover');
  }
});

document.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
});

document.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    stage.classList.remove('dragover');
    if (state === 'idle') {
      setLid('idle');
      setMonsterMode('idle');
    }
  }
});

document.addEventListener('drop', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  dragDepth = 0;
  stage.classList.remove('dragover');
  if (state === 'devouring') return;

  try {
    const files = e.dataTransfer.files;
    if (files.length === 0) return;
    const file = files[0];

    const dropped = await devourer.registerDroppedFile(file);

    if (!dropped) {
      const resolved = await devourer.resolvePath(file.name);
      if (!resolved) return;
      setTarget(resolved);
    } else {
      setTarget(dropped);
    }
  } catch (err) {
    showError(err.message);
  }
});

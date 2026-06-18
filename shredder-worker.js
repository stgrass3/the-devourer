const { parentPort, workerData } = require('worker_threads');
const { shredFile } = require('./shredder');

try {
  let lastProgressAt = 0;
  let lastPhase = '';
  const result = shredFile(workerData.filePath, (progress) => {
    const now = Date.now();
    const phaseChanged = progress.phase !== lastPhase;
    if (!phaseChanged && progress.pct < 1 && now - lastProgressAt < 50) return;

    lastProgressAt = now;
    lastPhase = progress.phase;
    parentPort.postMessage({ type: 'progress', progress });
  }, workerData.options);
  parentPort.postMessage({ type: 'done', result });
} catch (err) {
  parentPort.postMessage({
    type: 'done',
    result: { success: false, error: err.message },
  });
}

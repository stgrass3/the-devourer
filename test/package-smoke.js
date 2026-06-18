const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const packageJson = require('../package.json');
const artifact = path.join(root, 'artifacts', `The-Devourer-${packageJson.version}-portable-x64.exe`);
const sourceFiles = packageJson.build.files
  .filter((entry) => !entry.includes('*'))
  .map((entry) => path.join(root, entry));

function verifyArtifact() {
  assert.ok(fs.existsSync(artifact), `portable artifact missing: ${artifact}`);
  const artifactStats = fs.statSync(artifact);
  assert.ok(artifactStats.size > 10 * 1024 * 1024, 'portable artifact is unexpectedly small');

  const newestSourceMtime = Math.max(...sourceFiles.map((file) => fs.statSync(file).mtimeMs));
  assert.ok(
    artifactStats.mtimeMs >= newestSourceMtime,
    'portable artifact is older than packaged source files',
  );
}

function runPackagedSmoke() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.DEVOURER_IMPORT_ONLY;

    const child = spawn(artifact, ['--smoke-test'], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('packaged smoke test timed out'));
    }, 120_000);

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) setTimeout(resolve, 2_000);
      else reject(new Error(`packaged smoke test exited ${code}: ${stderr.trim()}`));
    });
  });
}

async function main() {
  verifyArtifact();
  await runPackagedSmoke();
  console.log('Packaged portable smoke test passed');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

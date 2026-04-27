const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Path the Claudex/Claude Code CLI scans for IDE lockfiles.
 * Format: ~/.claude/ide/<port>.lock — JSON describing how to reach this VS Code window.
 * The CLI's lookup logic lives in src/utils/ide.ts (getIdeLockfilesPaths).
 */
function getLockfileDir() {
  return path.join(os.homedir(), '.claude', 'ide');
}

function getLockfilePath(port) {
  return path.join(getLockfileDir(), `${port}.lock`);
}

function isWindows() {
  return process.platform === 'win32';
}

/**
 * Best-effort sync mkdir. The CLI tolerates missing dirs and will retry on its
 * own polling cycle, so we don't escalate failures here.
 */
function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    // Ignore — write step will surface real failures.
  }
}

function buildLockfileContent({ workspaceFolders, pid, ideName, authToken }) {
  return {
    pid,
    workspaceFolders: Array.isArray(workspaceFolders) ? workspaceFolders : [],
    ideName: ideName || 'VS Code',
    transport: 'ws',
    runningInWindows: isWindows(),
    authToken,
  };
}

/**
 * Write the lockfile. Returns the path on success, or null on failure.
 * Caller should not throw on failure — extension activation must continue
 * even if the home directory is read-only (sandboxed surfaces, CI, etc.).
 */
function writeLockfile({ port, workspaceFolders, pid, ideName, authToken }) {
  const dir = getLockfileDir();
  ensureDir(dir);
  const filePath = getLockfilePath(port);
  const payload = buildLockfileContent({
    workspaceFolders,
    pid,
    ideName,
    authToken,
  });
  try {
    fs.writeFileSync(filePath, JSON.stringify(payload), { encoding: 'utf8' });
    return filePath;
  } catch (_) {
    return null;
  }
}

function deleteLockfile(port) {
  const filePath = getLockfilePath(port);
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  buildLockfileContent,
  deleteLockfile,
  getLockfileDir,
  getLockfilePath,
  writeLockfile,
};

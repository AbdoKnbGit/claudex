const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildLockfileContent, writeLockfile, deleteLockfile, getLockfilePath } =
  require('./lockfile');

test('buildLockfileContent shapes the JSON the CLI expects', () => {
  const lockfile = buildLockfileContent({
    workspaceFolders: ['/work/project'],
    pid: 12345,
    ideName: 'VS Code',
    authToken: 'token-abc',
  });

  assert.equal(lockfile.pid, 12345);
  assert.deepEqual(lockfile.workspaceFolders, ['/work/project']);
  assert.equal(lockfile.ideName, 'VS Code');
  assert.equal(lockfile.transport, 'ws');
  assert.equal(lockfile.authToken, 'token-abc');
  assert.equal(typeof lockfile.runningInWindows, 'boolean');
});

test('buildLockfileContent normalizes missing fields', () => {
  const lockfile = buildLockfileContent({
    workspaceFolders: undefined,
    pid: 1,
    ideName: '',
    authToken: 'x',
  });

  assert.deepEqual(lockfile.workspaceFolders, []);
  assert.equal(lockfile.ideName, 'VS Code');
});

test('writeLockfile + deleteLockfile round-trip in a temp HOME', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-lockfile-'));
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;

  try {
    const port = 41111;
    const filePath = writeLockfile({
      port,
      workspaceFolders: ['/work/project'],
      pid: process.pid,
      ideName: 'VS Code',
      authToken: 'tk-1',
    });

    assert.ok(filePath, 'writeLockfile returns the file path');
    assert.equal(filePath, getLockfilePath(port));

    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.transport, 'ws');
    assert.equal(parsed.authToken, 'tk-1');
    assert.deepEqual(parsed.workspaceFolders, ['/work/project']);

    assert.equal(deleteLockfile(port), true);
    assert.equal(fs.existsSync(filePath), false);
  } finally {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('deleteLockfile is a no-op when the lockfile is missing', () => {
  // Use a port we never wrote — should return false without throwing.
  assert.equal(deleteLockfile(65530), false);
});

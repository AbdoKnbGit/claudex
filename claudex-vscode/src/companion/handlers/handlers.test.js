const test = require('node:test');
const assert = require('node:assert/strict');

const { createGetDiagnosticsHandler, severityLabel, diagnosticToWire } =
  require('./diagnostics');
const { createDiffHandlers, DiffManager } = require('./diff');

test('severityLabel maps VS Code severity numbers to readable strings', () => {
  assert.equal(severityLabel(0), 'Error');
  assert.equal(severityLabel(1), 'Warning');
  assert.equal(severityLabel(2), 'Information');
  assert.equal(severityLabel(3), 'Hint');
  assert.equal(severityLabel(99), 'Information'); // unknown -> Information
});

test('diagnosticToWire produces a minimal serializable record', () => {
  const wire = diagnosticToWire({
    severity: 0,
    message: 'oops',
    source: 'eslint',
    code: { value: 'no-unused-vars' },
    range: {
      start: { line: 5, character: 0 },
      end: { line: 5, character: 12 },
    },
  });

  assert.equal(wire.severity, 'Error');
  assert.equal(wire.message, 'oops');
  assert.equal(wire.source, 'eslint');
  assert.equal(wire.code, 'no-unused-vars');
  assert.deepEqual(wire.range.start, { line: 5, character: 0 });
});

test('getDiagnostics returns scoped diagnostics for a single uri', async () => {
  const fakeVscode = {
    Uri: {
      parse: value => ({ toString: () => value }),
    },
    languages: {
      getDiagnostics: target => {
        if (target) {
          return [
            {
              severity: 1,
              message: 'maybe',
              source: 'tsc',
              code: 2304,
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 },
              },
            },
          ];
        }
        return [];
      },
    },
  };

  const handler = createGetDiagnosticsHandler(fakeVscode);
  const result = await handler({ uri: 'file:///work/main.ts' });
  const parsed = JSON.parse(result.content[0].text);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].uri, 'file:///work/main.ts');
  assert.equal(parsed[0].diagnostics[0].severity, 'Warning');
  assert.equal(parsed[0].diagnostics[0].code, '2304');
});

test('getDiagnostics returns workspace-wide diagnostics when uri omitted', async () => {
  const fakeUri = u => ({ toString: () => u });
  const fakeVscode = {
    Uri: { parse: fakeUri },
    languages: {
      getDiagnostics: target => {
        if (target) return [];
        return [
          [
            fakeUri('file:///a.ts'),
            [
              {
                severity: 0,
                message: 'broken',
                range: {
                  start: { line: 1, character: 0 },
                  end: { line: 1, character: 3 },
                },
              },
            ],
          ],
          [fakeUri('file:///b.ts'), []],
        ];
      },
    },
  };

  const handler = createGetDiagnosticsHandler(fakeVscode);
  const result = await handler({});
  const parsed = JSON.parse(result.content[0].text);

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].uri, 'file:///a.ts');
  assert.equal(parsed[0].diagnostics[0].severity, 'Error');
  assert.equal(parsed[1].diagnostics.length, 0);
});

test('createDiffHandlers wraps DiffManager methods with MCP content envelopes', async () => {
  const fakeManager = {
    openDiff: async () => ({ accepted: true, content: 'hello world' }),
    closeTab: async () => ({ closed: 1 }),
    closeAllDiffTabs: async () => ({ closed: 3 }),
  };
  const handlers = createDiffHandlers(fakeManager);

  const accepted = await handlers.openDiff({});
  assert.equal(accepted.content[0].type, 'text');
  assert.match(accepted.content[0].text, /^FILE_CONTENTS:hello world/);

  fakeManager.openDiff = async () => ({ accepted: false, content: null });
  const rejected = await createDiffHandlers(fakeManager).openDiff({});
  assert.equal(rejected.content[0].text, 'FILE_REJECTED');

  const closeTabResult = await handlers.close_tab({ tab_name: 'foo' });
  assert.deepEqual(JSON.parse(closeTabResult.content[0].text), { closed: 1 });

  const closeAllResult = await handlers.closeAllDiffTabs();
  assert.deepEqual(JSON.parse(closeAllResult.content[0].text), { closed: 3 });
});

test('DiffManager.closeTab resolves pending RPCs without leaking entries', async () => {
  // Build a minimal vscode stub that lets DiffManager run end-to-end without a
  // real extension host. We never hit the real `vscode.diff` path here — we
  // only exercise the bookkeeping side of close_tab.
  const fakeUri = path => ({
    scheme: 'claudex-diff',
    path,
    toString: () => `claudex-diff://${path}`,
  });
  const tabGroups = { all: [{ tabs: [] }], close: async () => {} };
  const fakeVscode = {
    Uri: {
      from: ({ scheme, path: p }) => ({
        scheme,
        path: p,
        toString: () => `${scheme}://${p}`,
      }),
      file: p => fakeUri(p),
    },
    workspace: { workspaceFolders: [], fs: { stat: async () => {} } },
    window: { tabGroups, activeTextEditor: null },
    commands: { executeCommand: async () => {} },
    EventEmitter: class {
      constructor() {
        this.event = () => ({ dispose: () => {} });
      }
      fire() {}
    },
  };

  const provider = {
    setContent() {},
    deleteContent() {},
  };
  const manager = new DiffManager(fakeVscode, provider, () => {});

  // Fake the openDiff prelude: register an entry directly so we can test close.
  const tabName = 'foo.ts ↔ Claudex';
  const rightUri = fakeVscode.Uri.from({
    scheme: 'claudex-diff',
    path: '/work/foo.ts',
  });
  let resolvedWith = null;
  manager._byTabName.set(tabName, {
    resolve: value => {
      resolvedWith = value;
    },
    originalPath: '/work/foo.ts',
    rightUri,
    tabName,
  });
  manager._byRightUri.set(rightUri.toString(), tabName);

  const result = await manager.closeTab({ tab_name: tabName });
  assert.equal(result.closed, 1);
  assert.deepEqual(resolvedWith, {
    accepted: false,
    content: null,
    reason: 'closed',
  });
  assert.equal(manager._byTabName.size, 0);
  assert.equal(manager._byRightUri.size, 0);
});

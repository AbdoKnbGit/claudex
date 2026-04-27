const path = require('node:path');

const DIFF_SCHEME = 'claudex-diff';
const DIFF_VISIBLE_CONTEXT = 'claudex.diff.isVisible';

/**
 * Bundle of state owned by the extension that diff RPCs need access to:
 *   - vscode: the live `vscode` module
 *   - contentProvider: instance of DiffContentProvider (registered for DIFF_SCHEME)
 *   - log: function for diagnostics
 *
 * `Diffs` is a plain in-memory map keyed by tab name. Each entry stores the
 * pending Promise resolver so that accept/reject from the UI side can settle
 * the awaiting RPC.
 */

class DiffContentProvider {
  constructor(vscodeApi) {
    this._vscode = vscodeApi;
    this._content = new Map();
    this._emitter = new vscodeApi.EventEmitter();
    this.onDidChange = this._emitter.event;
  }

  provideTextDocumentContent(uri) {
    return this._content.get(uri.toString()) || '';
  }

  setContent(uri, text) {
    this._content.set(uri.toString(), text);
    this._emitter.fire(uri);
  }

  deleteContent(uri) {
    this._content.delete(uri.toString());
  }
}

class DiffManager {
  constructor(vscodeApi, contentProvider, log) {
    this._vscode = vscodeApi;
    this._content = contentProvider;
    this._log = log || (() => {});
    /** @type {Map<string, { resolve: Function, originalPath: string, rightUri: any, tabName: string }>} */
    this._byTabName = new Map();
    /** @type {Map<string, string>} rightUri.toString() -> tabName */
    this._byRightUri = new Map();
  }

  _setVisibleContext(visible) {
    return this._vscode.commands.executeCommand(
      'setContext',
      DIFF_VISIBLE_CONTEXT,
      visible,
    );
  }

  _toAbsolute(filePath) {
    if (!filePath) return null;
    if (path.isAbsolute(filePath)) return filePath;
    const folders = this._vscode.workspace.workspaceFolders || [];
    const root = folders[0] && folders[0].uri && folders[0].uri.fsPath;
    return root ? path.join(root, filePath) : filePath;
  }

  /**
   * Opens a diff view and returns a Promise that resolves once the user either
   * accepts (returns the modified content) or rejects (returns null).
   *
   * Tool-call args from the CLI side (Claude Code naming):
   *   { old_file_path, new_file_path, new_file_contents, tab_name }
   */
  async openDiff(args) {
    const oldPath = this._toAbsolute(args && args.old_file_path);
    const newPath =
      this._toAbsolute(args && args.new_file_path) || oldPath;
    const newContents =
      typeof (args && args.new_file_contents) === 'string'
        ? args.new_file_contents
        : '';
    const tabName =
      (args && args.tab_name) ||
      `${path.basename(newPath || 'untitled')} ↔ Claudex`;

    if (!oldPath && !newPath) {
      throw new Error('openDiff requires old_file_path or new_file_path');
    }

    const rightUri = this._vscode.Uri.from({
      scheme: DIFF_SCHEME,
      path: newPath || oldPath,
      query: `tab=${encodeURIComponent(tabName)}&t=${Date.now()}`,
    });
    this._content.setContent(rightUri, newContents);

    let leftUri;
    try {
      const fileUri = this._vscode.Uri.file(oldPath);
      await this._vscode.workspace.fs.stat(fileUri);
      leftUri = fileUri;
    } catch (_) {
      // File doesn't exist on disk — show against an empty untitled doc.
      leftUri = this._vscode.Uri.from({
        scheme: 'untitled',
        path: oldPath || newPath || 'untitled',
      });
    }

    await this._vscode.commands.executeCommand(
      'vscode.diff',
      leftUri,
      rightUri,
      tabName,
      { preview: false, preserveFocus: false },
    );
    await this._setVisibleContext(true);

    return new Promise(resolve => {
      // If a stale entry exists for the same tab name, resolve it as cancelled
      // before overwriting — never silently leak a pending RPC.
      const stale = this._byTabName.get(tabName);
      if (stale) {
        try {
          stale.resolve({ accepted: false, content: null, reason: 'replaced' });
        } catch (_) {
          // ignore
        }
      }

      this._byTabName.set(tabName, {
        resolve,
        originalPath: oldPath,
        rightUri,
        tabName,
      });
      this._byRightUri.set(rightUri.toString(), tabName);
    });
  }

  /**
   * Accepts the diff for a given right-side document URI (or active tab).
   * Reads the current text (user may have edited it before accepting) and
   * resolves the awaiting openDiff Promise.
   */
  async acceptDiff(uri) {
    const rightUri = uri || this._activeRightUri();
    if (!rightUri) return;
    const tabName = this._byRightUri.get(rightUri.toString());
    if (!tabName) return;
    const entry = this._byTabName.get(tabName);
    if (!entry) return;

    let modified = '';
    try {
      const doc = await this._vscode.workspace.openTextDocument(rightUri);
      modified = doc.getText();
    } catch (e) {
      this._log(`acceptDiff: failed to read modified content: ${e.message}`);
    }

    await this._closeTabForRightUri(rightUri);
    this._cleanup(tabName, rightUri);
    entry.resolve({ accepted: true, content: modified });
  }

  async rejectDiff(uri) {
    const rightUri = uri || this._activeRightUri();
    if (!rightUri) return;
    const tabName = this._byRightUri.get(rightUri.toString());
    if (!tabName) return;
    const entry = this._byTabName.get(tabName);
    if (!entry) return;

    await this._closeTabForRightUri(rightUri);
    this._cleanup(tabName, rightUri);
    entry.resolve({ accepted: false, content: null });
  }

  /**
   * Called by VS Code when the diff doc is closed (e.g., user clicked X).
   * Treat as reject, but only if not already settled.
   */
  async onDocumentClosed(closedUri) {
    if (!closedUri || closedUri.scheme !== DIFF_SCHEME) return;
    const tabName = this._byRightUri.get(closedUri.toString());
    if (!tabName) return;
    const entry = this._byTabName.get(tabName);
    if (!entry) return;

    this._cleanup(tabName, closedUri);
    entry.resolve({ accepted: false, content: null });
  }

  _activeRightUri() {
    const active = this._vscode.window.activeTextEditor;
    if (active && active.document.uri.scheme === DIFF_SCHEME) {
      return active.document.uri;
    }
    return null;
  }

  async _closeTabForRightUri(rightUri) {
    try {
      const tabGroups = this._vscode.window.tabGroups;
      if (!tabGroups || !tabGroups.all) return;
      for (const group of tabGroups.all) {
        for (const tab of group.tabs) {
          const input = tab.input;
          if (
            input &&
            this._vscode.TabInputTextDiff &&
            input instanceof this._vscode.TabInputTextDiff &&
            input.modified &&
            input.modified.toString() === rightUri.toString()
          ) {
            await tabGroups.close(tab);
            return;
          }
        }
      }
    } catch (e) {
      this._log(`closeTabForRightUri: ${e.message}`);
    }
  }

  _cleanup(tabName, rightUri) {
    this._byTabName.delete(tabName);
    if (rightUri) {
      this._byRightUri.delete(rightUri.toString());
      this._content.deleteContent(rightUri);
    }
    if (this._byTabName.size === 0) {
      void this._setVisibleContext(false);
    }
  }

  async closeTab(args) {
    const tabName = args && args.tab_name;
    if (!tabName) {
      return { closed: 0 };
    }
    const entry = this._byTabName.get(tabName);
    if (entry) {
      await this._closeTabForRightUri(entry.rightUri);
      this._cleanup(tabName, entry.rightUri);
      entry.resolve({ accepted: false, content: null, reason: 'closed' });
      return { closed: 1 };
    }
    // Fall back to closing any tab whose label matches.
    let closed = 0;
    try {
      const tabGroups = this._vscode.window.tabGroups;
      if (tabGroups && tabGroups.all) {
        for (const group of tabGroups.all) {
          for (const tab of group.tabs) {
            if (tab.label === tabName) {
              await tabGroups.close(tab);
              closed += 1;
            }
          }
        }
      }
    } catch (e) {
      this._log(`closeTab: ${e.message}`);
    }
    return { closed };
  }

  async closeAllDiffTabs() {
    let closed = 0;
    const entries = [...this._byTabName.entries()];
    for (const [tabName, entry] of entries) {
      try {
        await this._closeTabForRightUri(entry.rightUri);
      } catch (_) {
        // continue closing the rest
      }
      this._cleanup(tabName, entry.rightUri);
      entry.resolve({ accepted: false, content: null, reason: 'closeAll' });
      closed += 1;
    }
    return { closed };
  }
}

function createDiffHandlers(diffManager) {
  return {
    openDiff: async args => {
      const result = await diffManager.openDiff(args);
      const text = result.accepted
        ? `FILE_CONTENTS:${result.content || ''}`
        : 'FILE_REJECTED';
      return { content: [{ type: 'text', text }] };
    },
    close_tab: async args => {
      const result = await diffManager.closeTab(args || {});
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    },
    closeAllDiffTabs: async () => {
      const result = await diffManager.closeAllDiffTabs();
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    },
  };
}

module.exports = {
  DIFF_SCHEME,
  DIFF_VISIBLE_CONTEXT,
  DiffContentProvider,
  DiffManager,
  createDiffHandlers,
};

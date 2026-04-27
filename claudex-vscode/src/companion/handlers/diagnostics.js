// VS Code's diagnostic severity values are 0–3 (Error, Warning, Info, Hint).
// We translate to short strings so the CLI's prompt formatter stays
// implementation-agnostic — matches Claude Code's own getDiagnostics shape.
const SEVERITY_LABELS = ['Error', 'Warning', 'Information', 'Hint'];

function severityLabel(severity) {
  return SEVERITY_LABELS[severity] || 'Information';
}

function rangeToObject(range) {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

function diagnosticToWire(diag) {
  return {
    severity: severityLabel(diag.severity),
    message: diag.message,
    source: diag.source || undefined,
    code:
      typeof diag.code === 'object' && diag.code !== null
        ? String(diag.code.value)
        : diag.code !== undefined
          ? String(diag.code)
          : undefined,
    range: rangeToObject(diag.range),
  };
}

/**
 * Build the getDiagnostics handler. `vscodeApi` is injected so the unit tests
 * can run without spinning up a VS Code extension host.
 *
 * Args contract (matches Claude Code's MCP IDE tool):
 *   { uri?: string }  — file URI to scope to. Omit for all workspace diagnostics.
 *
 * Return shape: a single text content block whose JSON body is an array of
 *   { uri, diagnostics: [...] } entries. The CLI reads it as opaque text and
 *   surfaces it to the model.
 */
function createGetDiagnosticsHandler(vscodeApi) {
  return async function getDiagnostics(args) {
    const targetUri = args && typeof args.uri === 'string' ? args.uri : null;

    let entries;
    if (targetUri) {
      const uri = vscodeApi.Uri.parse(targetUri);
      const diagnostics = vscodeApi.languages.getDiagnostics(uri);
      entries = [
        {
          uri: uri.toString(),
          diagnostics: diagnostics.map(diagnosticToWire),
        },
      ];
    } else {
      const all = vscodeApi.languages.getDiagnostics();
      entries = all.map(([uri, diagnostics]) => ({
        uri: uri.toString(),
        diagnostics: diagnostics.map(diagnosticToWire),
      }));
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(entries),
        },
      ],
    };
  };
}

module.exports = {
  createGetDiagnosticsHandler,
  diagnosticToWire,
  severityLabel,
};

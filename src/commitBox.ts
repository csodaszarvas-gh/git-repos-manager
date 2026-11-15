import * as vscode from 'vscode';

/**
 * Multi-line commit message box (webview): Enter inserts a newline,
 * Ctrl+Enter (Cmd+Enter on macOS) commits, Esc cancels.
 * Resolves with the message, or undefined when cancelled/dismissed.
 */
export function showCommitBox(
  repoName: string,
  stageAllChanges: boolean,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel(
      'gitReposManagerCommitBox',
      `Commit — ${repoName}`,
      vscode.ViewColumn.Active,
      // Keep the draft alive when the user switches editor tabs.
      { enableScripts: true, retainContextWhenHidden: true },
    );
    const nonce = getNonce();
    panel.webview.html = buildHtml(repoName, stageAllChanges, nonce);
    let done = false;
    const finish = (value: string | undefined): void => {
      if (done) {
        return;
      }
      done = true;
      resolve(value);
      panel.dispose();
    };
    panel.webview.onDidReceiveMessage((msg: { type?: string; message?: string }) => {
      if (msg.type === 'commit' && typeof msg.message === 'string' && msg.message.trim()) {
        finish(msg.message);
      } else if (msg.type === 'cancel') {
        finish(undefined);
      }
    });
    panel.onDidDispose(() => finish(undefined));
  });
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildHtml(repoName: string, stageAllChanges: boolean, nonce: string): string {
  const note = stageAllChanges
    ? 'All changes will be staged before committing.'
    : 'Only staged changes will be committed.';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; }
  h2 { font-size: 13px; font-weight: 600; margin: 0 0 6px; }
  .note { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 8px; }
  textarea {
    width: 100%; box-sizing: border-box; min-height: 150px; resize: vertical;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px;
    font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size);
    padding: 8px; outline: none;
  }
  textarea:focus { border-color: var(--vscode-focusBorder); }
  .actions { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
  button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; padding: 6px 14px; border-radius: 2px; cursor: pointer; font-size: 13px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .hint { color: var(--vscode-descriptionForeground); font-size: 11px; margin-left: auto; }
  .error { color: var(--vscode-errorForeground); font-size: 12px; margin-top: 6px; display: none; }
</style>
</head>
<body>
  <h2>Commit message — ${escapeHtml(repoName)}</h2>
  <div class="note">${note}</div>
  <textarea id="msg" placeholder="Subject line&#10;&#10;Optional body…" spellcheck="false"></textarea>
  <div class="error" id="err">A commit message is required.</div>
  <div class="actions">
    <button id="commit">Commit</button>
    <button id="cancel" class="secondary">Cancel</button>
    <span class="hint">Enter: new line · Ctrl+Enter: commit · Esc: cancel</span>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const ta = document.getElementById('msg');
    const err = document.getElementById('err');
    ta.focus();
    function submit() {
      if (!ta.value.trim()) {
        err.style.display = 'block';
        ta.focus();
        return;
      }
      vscode.postMessage({ type: 'commit', message: ta.value });
    }
    document.getElementById('commit').addEventListener('click', submit);
    document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        vscode.postMessage({ type: 'cancel' });
      }
    });
    ta.addEventListener('input', () => { err.style.display = 'none'; });
  </script>
</body>
</html>`;
}
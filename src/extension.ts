import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { DIFF_SCHEME, GitDiffProvider } from './diffProvider';
import { RepoTreeProvider } from './reposTree';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Git Repos Manager');
  const log = (message: string): void => {
    output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
  };
  log('Git Repos Manager activated.');

  const tree = new RepoTreeProvider(log);
  context.subscriptions.push(
    output,
    vscode.window.registerTreeDataProvider('gitReposManager.reposView', tree),
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, new GitDiffProvider()),
  );

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'gitReposManager.refresh';
  statusBar.tooltip = 'Git Repos Manager — click to refresh';
  context.subscriptions.push(statusBar);

  const updateStatusBar = (): void => {
    const stats = tree.getStats();
    const repos = `${stats.total} repo${stats.total === 1 ? '' : 's'}`;
    statusBar.text = `$(git-branch) ${repos}${stats.dirty > 0 ? ` • ${stats.dirty} dirty` : ''}`;
    statusBar.show();
  };
  context.subscriptions.push(tree.onDidChangeTreeData(updateStatusBar));

  registerCommands(context, tree, log);

  // Auto-refresh when Git metadata changes on disk (debounced).
  let refreshTimer: NodeJS.Timeout | undefined;
  const scheduleRefresh = (): void => {
    if (!vscode.workspace.getConfiguration('gitReposManager').get<boolean>('autoRefresh', true)) {
      return;
    }
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => void tree.refresh(), 750);
  };
  for (const pattern of ['**/.git/HEAD', '**/.git/index', '**/.git/refs/**']) {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidChange(scheduleRefresh);
    watcher.onDidCreate(scheduleRefresh);
    watcher.onDidDelete(scheduleRefresh);
    context.subscriptions.push(watcher);
  }
  context.subscriptions.push({ dispose: () => refreshTimer && clearTimeout(refreshTimer) });

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => void tree.refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gitReposManager')) {
        void tree.refresh();
      }
    }),
  );

  void tree.refresh();
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
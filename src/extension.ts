import * as vscode from 'vscode';
import { ChangedFilesProvider } from './changedFilesTree';
import { registerCommands, registerHistoryCommands } from './commands';
import { DIFF_SCHEME, GitDiffProvider } from './diffProvider';
import { CommitInfo } from './git';
import { CommitItem, HistoryProvider } from './historyTree';
import { Repository } from './repoScanner';
import { RepoItem, RepoTreeProvider } from './reposTree';
import { WorkingTreeProvider } from './workingTree';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Git Repos Manager');
  const log = (message: string): void => {
    output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
  };
  log('Git Repos Manager activated.');

  const tree = new RepoTreeProvider(log);
  const history = new HistoryProvider(log);
  const changedFiles = new ChangedFilesProvider(log);
  const workingTree = new WorkingTreeProvider(log);

  const reposView = vscode.window.createTreeView('gitReposManager.reposView', {
    treeDataProvider: tree,
    canSelectMany: true,
  });
  const historyView = vscode.window.createTreeView('gitReposManager.historyView', {
    treeDataProvider: history,
    canSelectMany: true,
  });
  const changedFilesView = vscode.window.createTreeView('gitReposManager.changedFilesView', {
    treeDataProvider: changedFiles,
  });
  const workingTreeView = vscode.window.createTreeView('gitReposManager.workingTreeView', {
    treeDataProvider: workingTree,
    canSelectMany: true,
  });

  context.subscriptions.push(
    output,
    reposView,
    historyView,
    changedFilesView,
    workingTreeView,
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, new GitDiffProvider()),
  );

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'gitReposManager.refresh';
  statusBar.tooltip = 'Git Repos Manager — click to refresh';
  context.subscriptions.push(statusBar);

  let currentRepoItem: RepoItem | undefined;
  const updateHistoryMeta = (): void => {
    const filters = history.getFilters();
    void vscode.commands.executeCommand(
      'setContext',
      'gitReposManager.historyFiltered',
      Boolean(filters.message || filters.author || filters.ref),
    );
    const repo = history.getRepo();
    if (!repo) {
      historyView.message = undefined;
      return;
    }
    const parts = [repo.name];
    if (currentRepoItem?.status?.branch) {
      parts.push(currentRepoItem.status.branch);
    }
    if (filters.ref) {
      parts.push(`branch: ${filters.ref === '--all' ? 'all' : filters.ref}`);
    }
    if (filters.message) {
      parts.push(`message: "${filters.message}"`);
    }
    if (filters.author) {
      parts.push(`author: "${filters.author}"`);
    }
    historyView.message = parts.join(' • ');
  };
  const updateWorkingTreeMeta = (): void => {
    const repo = workingTree.getRepo();
    workingTreeView.message = repo
      ? `${repo.name}${currentRepoItem?.status?.branch ? ` • ${currentRepoItem.status.branch}` : ''}`
      : undefined;
  };
  const selectHistoryRepo = (item: RepoItem | undefined): void => {
    currentRepoItem = item;
    history.setRepo(item?.repo);
    workingTree.setRepo(item?.repo);
    updateHistoryMeta();
    updateWorkingTreeMeta();
  };

  const showChangedFiles = async (
    repo: Repository | undefined,
    commits: CommitInfo[],
    focusPanel: boolean,
  ): Promise<void> => {
    const count = await changedFiles.setCommits(repo, commits);
    changedFilesView.message =
      commits.length > 0
        ? `${commits.length} commit${commits.length === 1 ? '' : 's'} selected • ${count} file${count === 1 ? '' : 's'}`
        : undefined;
    changedFilesView.badge =
      count > 0 ? { value: count, tooltip: 'Files changed by the selected commits' } : undefined;
    await vscode.commands.executeCommand('setContext', 'gitReposManager.changedFilesCount', count);
    if (focusPanel) {
      await vscode.commands.executeCommand('gitReposManager.changedFilesView.focus');
    }
  };

  const updateStatusBar = (): void => {
    const stats = tree.getStats();
    const repos = `${stats.total} repo${stats.total === 1 ? '' : 's'}`;
    statusBar.text = `$(git-branch) ${repos}${stats.dirty > 0 ? ` • ${stats.dirty} dirty` : ''}`;
    statusBar.show();

    // Keep the History view in sync with the selected repository.
    const items = tree.getItems();
    const current = history.getRepo();
    const currentItem = current ? items.find((i) => i.repo.root === current.root) : undefined;
    if (current && !currentItem) {
      selectHistoryRepo(undefined);
    } else if (!current && items.length === 1) {
      selectHistoryRepo(items[0]);
    }
    if (currentItem) {
      currentRepoItem = currentItem;
    }
    history.syncOid(currentItem?.status?.oid);
    updateHistoryMeta();
    updateWorkingTreeMeta();
  };
  context.subscriptions.push(tree.onDidChangeTreeData(updateStatusBar));
  // The Working Tree tab mirrors the sidebar status after every refresh.
  context.subscriptions.push(tree.onDidChangeTreeData(() => void workingTree.refresh()));
  context.subscriptions.push(
    workingTree.onDidChangeTreeData(() => {
      const count = workingTree.getChangeCount();
      workingTreeView.badge =
        count > 0 ? { value: count, tooltip: 'Changed files in the working tree' } : undefined;
    }),
  );

  context.subscriptions.push(
    reposView.onDidChangeSelection((e) => {
      const repoItem = e.selection.find((i): i is RepoItem => i instanceof RepoItem);
      if (repoItem) {
        selectHistoryRepo(repoItem);
      }
    }),
    historyView.onDidChangeSelection((e) => {
      const commits = e.selection
        .filter((i): i is CommitItem => i instanceof CommitItem)
        .map((i) => i.commit);
      void showChangedFiles(history.getRepo(), commits, false);
    }),
  );

  registerCommands(context, tree, log, () => workingTree.getRepo());
  registerHistoryCommands(context, history, showChangedFiles, updateHistoryMeta, tree, log);

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
  void vscode.commands.executeCommand('setContext', 'gitReposManager.changedFilesCount', 0);
  void vscode.commands.executeCommand('setContext', 'gitReposManager.historyCommitCount', 0);
  void vscode.commands.executeCommand('setContext', 'gitReposManager.historyFiltered', false);
  void vscode.commands.executeCommand('setContext', 'gitReposManager.workingTreeHasRepo', false);
  void vscode.commands.executeCommand('setContext', 'gitReposManager.workingTreeCount', 0);
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
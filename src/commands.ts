import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { CombinedFileItem } from './changedFilesTree';
import { showCommitBox } from './commitBox';
import { makeRefUri } from './diffProvider';
import { CommitInfo, getAuthors, getBranches, getStatus, git, isAncestor, LogFilter, LogFn } from './git';
import { CommitFileItem, CommitItem, HistoryProvider } from './historyTree';
import { Repository } from './repoScanner';
import { FileItem, GroupItem, RepoItem, RepoTreeProvider } from './reposTree';

export function registerCommands(
  context: vscode.ExtensionContext,
  tree: RepoTreeProvider,
  log: LogFn,
  getCurrentRepo: () => Repository | undefined,
): void {
  // Title-bar/palette invocations carry no tree item: fall back to the repo
  // currently shown in the Working Tree tab, with a fresh status read.
  const commitFrom = async (item: RepoItem | undefined, stageAllChanges: boolean): Promise<void> => {
    if (item) {
      await commit(item.repo, item.status?.staged ?? 0, item.changeCount, tree, log, stageAllChanges);
      return;
    }
    const repo = getCurrentRepo();
    if (!repo) {
      void vscode.window.showInformationMessage('Git Repos: select a repository first.');
      return;
    }
    try {
      const status = await getStatus(repo.root);
      await commit(repo, status.staged, status.files.length, tree, log, stageAllChanges);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`Failed to read status of ${repo.root}: ${message}`);
      void vscode.window.showErrorMessage(`Commit failed: ${message}`);
    }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('gitReposManager.refresh', () => tree.refresh()),
    vscode.commands.registerCommand('gitReposManager.fetchAll', () => fetchAll(tree, log)),
    vscode.commands.registerCommand('gitReposManager.fetch', (item?: RepoItem) =>
      item && runGit(item.repo, ['fetch', '--prune'], 'Fetch', tree, log),
    ),
    vscode.commands.registerCommand('gitReposManager.pull', (item?: RepoItem) =>
      item && runGit(item.repo, ['pull', '--ff-only'], 'Pull', tree, log),
    ),
    vscode.commands.registerCommand('gitReposManager.push', (item?: RepoItem) =>
      item && runGit(item.repo, ['push'], 'Push', tree, log),
    ),
    vscode.commands.registerCommand('gitReposManager.openTerminal', (item?: RepoItem) => {
      if (!item) {
        return;
      }
      vscode.window.createTerminal({ name: `Git: ${item.repo.name}`, cwd: item.repo.root }).show();
    }),
    vscode.commands.registerCommand('gitReposManager.copyPath', async (item?: RepoItem) => {
      if (!item) {
        return;
      }
      await vscode.env.clipboard.writeText(item.repo.root);
      void vscode.window.showInformationMessage(`Copied: ${item.repo.root}`);
    }),
    vscode.commands.registerCommand('gitReposManager.stageFile', (item?: FileItem) =>
      item && runGit(item.repo, ['add', '--', item.change.path], `Stage ${item.change.path}`, tree, log),
    ),
    vscode.commands.registerCommand('gitReposManager.unstageFile', (item?: FileItem) =>
      item && runGit(item.repo, ['reset', '-q', '--', item.change.path], `Unstage ${item.change.path}`, tree, log),
    ),
    vscode.commands.registerCommand('gitReposManager.stageAll', (item?: RepoItem) => {
      if (!item) {
        return;
      }
      if (item.changeCount === 0) {
        void vscode.window.showInformationMessage(`Nothing to stage in ${item.repo.name}.`);
        return;
      }
      void runGit(item.repo, ['add', '-A'], 'Stage all changes', tree, log);
    }),
    vscode.commands.registerCommand('gitReposManager.unstageAll', (item?: RepoItem) =>
      item && unstageAll(item.repo, item.status?.staged ?? 0, tree, log),
    ),
    vscode.commands.registerCommand('gitReposManager.stageGroup', (item?: GroupItem) =>
      item && stageGroup(item, tree, log),
    ),
    vscode.commands.registerCommand('gitReposManager.unstageGroup', (item?: GroupItem) =>
      item && unstageAll(item.repo, item.files.length, tree, log),
    ),
    vscode.commands.registerCommand('gitReposManager.commit', (item?: RepoItem) =>
      commitFrom(item, false),
    ),
    vscode.commands.registerCommand('gitReposManager.commitAll', (item?: RepoItem) =>
      commitFrom(item, true),
    ),
    vscode.commands.registerCommand('gitReposManager.openChanges', (item?: FileItem) =>
      openChanges(item),
    ),
    vscode.commands.registerCommand(
      'gitReposManager.discardFiles',
      (item?: FileItem, items?: FileItem[]) => {
        // With canSelectMany, the second argument carries the full selection.
        const selected = items && items.length > 0 ? items : item ? [item] : [];
        if (selected.length > 0) {
          void discardChanges(selected, tree, log);
        }
      },
    ),
  );
}

/** Run git steps sequentially under one progress indicator; returns success. */
async function runGitSteps(
  repo: Repository,
  steps: string[][],
  label: string,
  tree: RepoTreeProvider,
  log: LogFn,
): Promise<boolean> {
  const title = `${label} — ${repo.name}`;
  let ok = true;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title },
      async () => {
        for (const args of steps) {
          const out = await git(repo.root, args, log);
          if (out.trim()) {
            log(out.trim());
          }
        }
      },
    );
  } catch (err) {
    ok = false;
    const message = err instanceof Error ? err.message : String(err);
    log(`${title} failed: ${message}`);
    void vscode.window.showErrorMessage(`${title} failed: ${message}`);
  } finally {
    await tree.refresh();
  }
  return ok;
}

function runGit(
  repo: Repository,
  args: string[],
  label: string,
  tree: RepoTreeProvider,
  log: LogFn,
): Promise<boolean> {
  return runGitSteps(repo, [args], label, tree, log);
}

/**
 * Discard uncommitted changes for the selected files: revert tracked files,
 * delete untracked/newly added ones. Confirmed through a modal dialog because
 * the operation cannot be undone.
 */
async function discardChanges(
  selected: FileItem[],
  tree: RepoTreeProvider,
  log: LogFn,
): Promise<void> {
  const byRepo = new Map<string, { repo: Repository; items: FileItem[] }>();
  for (const item of selected) {
    const entry = byRepo.get(item.repo.root) ?? { repo: item.repo, items: [] };
    entry.items.push(item);
    byRepo.set(item.repo.root, entry);
  }
  const total = selected.length;
  const paths = selected.map((i) => i.change.path);
  const detail =
    paths.slice(0, 20).join('\n') +
    (paths.length > 20 ? `\n…and ${paths.length - 20} more` : '');
  const confirm = await vscode.window.showWarningMessage(
    `Discard changes to ${total} file${total === 1 ? '' : 's'}? ` +
      'Untracked and newly added files will be deleted from disk. This cannot be undone.',
    { modal: true, detail },
    'Discard Changes',
  );
  if (confirm !== 'Discard Changes') {
    return;
  }
  for (const { repo, items } of byRepo.values()) {
    const resetPaths: string[] = [];
    const checkoutPaths: string[] = [];
    const deletions: string[] = [];
    for (const item of items) {
      const change = item.change;
      if (item.kind === 'untracked') {
        deletions.push(change.path);
      } else if (item.kind === 'staged' && change.x === 'A') {
        // Newly added: unstage and remove from disk.
        deletions.push(change.path);
        resetPaths.push(change.path);
      } else if (item.kind === 'staged' && change.origPath) {
        // Staged rename: restore the original path, remove the new one.
        resetPaths.push(change.path, change.origPath);
        checkoutPaths.push(change.origPath);
        deletions.push(change.path);
      } else if (item.kind === 'staged' || item.kind === 'conflicts') {
        // Full rollback to HEAD (also clears merge conflicts).
        resetPaths.push(change.path);
        checkoutPaths.push(change.path);
      } else {
        // Unstaged: revert the worktree to the index, keeping staged content.
        checkoutPaths.push(change.path);
      }
    }
    for (const rel of deletions) {
      try {
        await fs.promises.unlink(path.join(repo.root, rel));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          log(`Failed to delete ${rel} in ${repo.root}: ${String(err)}`);
        }
      }
    }
    const steps: string[][] = [];
    for (let i = 0; i < resetPaths.length; i += 50) {
      steps.push(['reset', '-q', '--', ...resetPaths.slice(i, i + 50)]);
    }
    for (let i = 0; i < checkoutPaths.length; i += 50) {
      steps.push(['checkout', '--', ...checkoutPaths.slice(i, i + 50)]);
    }
    if (steps.length > 0) {
      await runGitSteps(repo, steps, 'Discard changes', tree, log);
    } else {
      await tree.refresh();
    }
  }
  void vscode.window.showInformationMessage(
    `Discarded changes to ${total} file${total === 1 ? '' : 's'}.`,
  );
}

async function unstageAll(
  repo: Repository,
  stagedCount: number,
  tree: RepoTreeProvider,
  log: LogFn,
): Promise<void> {
  if (stagedCount === 0) {
    void vscode.window.showInformationMessage(`Nothing staged in ${repo.name}.`);
    return;
  }
  await runGit(repo, ['reset', '-q'], 'Unstage all changes', tree, log);
}

async function stageGroup(item: GroupItem, tree: RepoTreeProvider, log: LogFn): Promise<void> {
  if (item.kind === 'changes') {
    // Tracked modifications and deletions only, matching the group content.
    await runGit(item.repo, ['add', '-u', '--', '.'], 'Stage changes', tree, log);
    return;
  }
  // Untracked/conflicted files: stage explicit paths, in batches to keep
  // command lines at a safe length.
  const paths = item.files.map((f) => f.path);
  const steps: string[][] = [];
  for (let i = 0; i < paths.length; i += 50) {
    steps.push(['add', '--', ...paths.slice(i, i + 50)]);
  }
  await runGitSteps(item.repo, steps, 'Stage files', tree, log);
}

async function commit(
  repo: Repository,
  stagedCount: number,
  changeCount: number,
  tree: RepoTreeProvider,
  log: LogFn,
  stageAllChanges: boolean,
): Promise<void> {
  if (stageAllChanges && changeCount === 0) {
    void vscode.window.showInformationMessage(`Nothing to commit in ${repo.name}.`);
    return;
  }
  if (!stageAllChanges && stagedCount === 0) {
    if (changeCount === 0) {
      void vscode.window.showWarningMessage(
        `No staged changes in ${repo.name}. Stage files first, or use "Stage All & Commit".`,
      );
      return;
    }
    // Nothing staged but the tree is dirty: offer the one-click flow.
    const pick = await vscode.window.showWarningMessage(
      `No staged changes in ${repo.name}. Stage all ${changeCount} changed file${changeCount === 1 ? '' : 's'} and commit?`,
      'Stage All & Commit',
    );
    if (pick !== 'Stage All & Commit') {
      return;
    }
    stageAllChanges = true;
  }
  const message = await showCommitBox(repo.name, stageAllChanges);
  if (!message || !message.trim()) {
    return;
  }
  const steps: string[][] = [];
  if (stageAllChanges) {
    steps.push(['add', '-A']);
  }
  // git -m keeps trailing blank lines (cleanup=whitespace): trim them ourselves.
  steps.push(['commit', '-m', message.replace(/\s+$/, '')]);
  const ok = await runGitSteps(repo, steps, 'Commit', tree, log);
  if (ok) {
    void vscode.window.showInformationMessage(`Committed in ${repo.name}.`);
  }
}

function openChanges(item: FileItem | undefined): void {
  if (!item) {
    return;
  }
  const fileUri = vscode.Uri.file(path.join(item.repo.root, item.change.path));
  if (item.kind === 'untracked' || item.kind === 'conflicts') {
    void vscode.window.showTextDocument(fileUri);
    return;
  }
  const refUri = (ref: string): vscode.Uri =>
    makeRefUri(item.repo.root, item.change.path, ref);
  const name = path.basename(item.change.path);
  if (item.kind === 'staged') {
    void vscode.commands.executeCommand(
      'vscode.diff',
      refUri('HEAD'),
      refUri('index'),
      `${name} (HEAD ↔ Index)`,
    );
  } else {
    const right = item.change.y === 'D' ? refUri('empty') : fileUri;
    void vscode.commands.executeCommand(
      'vscode.diff',
      refUri('index'),
      right,
      `${name} (Index ↔ Working Tree)`,
    );
  }
}

export function registerHistoryCommands(
  context: vscode.ExtensionContext,
  history: HistoryProvider,
  showChangedFiles: (
    repo: Repository,
    commits: CommitInfo[],
    focusPanel: boolean,
  ) => Promise<void>,
  updateHistoryMeta: () => void,
  tree: RepoTreeProvider,
  log: LogFn,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('gitReposManager.refreshHistory', () => history.refresh()),
    vscode.commands.registerCommand('gitReposManager.searchHistory', () =>
      searchHistory(history, updateHistoryMeta),
    ),
    vscode.commands.registerCommand('gitReposManager.clearHistoryFilters', () => {
      history.clearFilters();
      updateHistoryMeta();
    }),
    vscode.commands.registerCommand('gitReposManager.loadMoreHistory', () => history.loadMore()),
    vscode.commands.registerCommand(
      'gitReposManager.showChangedFiles',
      (item?: CommitItem, items?: CommitItem[]) => {
        // With canSelectMany, the second argument carries the full selection.
        const selected = items && items.length > 0 ? items : item ? [item] : [];
        if (selected.length === 0) {
          return;
        }
        void showChangedFiles(selected[0].repo, selected.map((i) => i.commit), true);
      },
    ),
    vscode.commands.registerCommand('gitReposManager.openCommitFile', (item?: CommitFileItem) => {
      if (!item) {
        return;
      }
      const { repo, commit, change } = item;
      void vscode.commands.executeCommand(
        'vscode.diff',
        makeRefUri(repo.root, change.path, `${commit.hash}^1`),
        makeRefUri(repo.root, change.path, commit.hash),
        `${path.basename(change.path)} (${commit.shortHash})`,
      );
    }),
    vscode.commands.registerCommand('gitReposManager.openCombinedFile', (item?: CombinedFileItem) => {
      if (!item || item.file.entries.length === 0) {
        return;
      }
      // Entries are sorted oldest → newest: diff across the whole selection.
      const entries = item.file.entries;
      const oldest = entries[0].commit;
      const newest = entries[entries.length - 1].commit;
      const title =
        entries.length === 1
          ? `${path.basename(item.file.path)} (${oldest.shortHash})`
          : `${path.basename(item.file.path)} (${oldest.shortHash} ↔ ${newest.shortHash})`;
      void vscode.commands.executeCommand(
        'vscode.diff',
        makeRefUri(item.repo.root, item.file.path, `${oldest.hash}^1`),
        makeRefUri(item.repo.root, item.file.path, newest.hash),
        title,
      );
    }),
    vscode.commands.registerCommand('gitReposManager.resetToCommit', (item?: CommitItem) => {
      if (item) {
        void resetToCommit(item, tree, log);
      }
    }),
  );
}

/**
 * Mixed reset of the current branch to the selected commit: later commits are
 * undone but their changes stay in the working tree as uncommitted changes.
 */
async function resetToCommit(item: CommitItem, tree: RepoTreeProvider, log: LogFn): Promise<void> {
  const { repo, commit } = item;
  let status;
  try {
    status = await getStatus(repo.root);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Reset failed: ${message}`);
    return;
  }
  if (status.oid === commit.hash) {
    void vscode.window.showInformationMessage('Already at this commit.');
    return;
  }
  if (!(await isAncestor(repo.root, commit.hash))) {
    void vscode.window.showErrorMessage(
      `Cannot reset: ${commit.shortHash} is not in the current branch history.`,
    );
    return;
  }
  const undone = (await git(repo.root, ['rev-list', '--count', `${commit.hash}..HEAD`])).trim();
  const branch = status.branch ?? 'detached HEAD';
  const confirm = await vscode.window.showWarningMessage(
    `Reset ${branch} to ${commit.shortHash}? ${undone} later commit${undone === '1' ? '' : 's'} ` +
      'will be undone; their changes are kept in the working tree as uncommitted changes.',
    {
      modal: true,
      detail:
        `${commit.subject}\n${commit.hash}\n\n` +
        'Existing uncommitted changes are preserved. Undoable via git reflog.',
    },
    'Reset Branch',
  );
  if (confirm !== 'Reset Branch') {
    return;
  }
  const ok = await runGitSteps(repo, [['reset', '--mixed', commit.hash]], 'Reset to commit', tree, log);
  if (ok) {
    void vscode.window.showInformationMessage(
      `Reset ${repo.name} to ${commit.shortHash}. Undone changes are in the Working Tree.`,
    );
  }
}

async function searchHistory(history: HistoryProvider, updateHistoryMeta: () => void): Promise<void> {
  const repo = history.getRepo();
  if (!repo) {
    void vscode.window.showInformationMessage('Git Repos: select a repository first.');
    return;
  }
  const mode = await vscode.window.showQuickPick(
    [
      { label: '$(edit) Message', description: 'Search commit messages', mode: 'message' as const },
      { label: '$(person) Author', description: 'Filter by author name or email', mode: 'author' as const },
      { label: '$(git-branch) Branch', description: 'Show history of a specific branch', mode: 'branch' as const },
    ],
    { placeHolder: 'Search commits by...' },
  );
  if (!mode) {
    return;
  }
  if (mode.mode === 'branch') {
    const branches = await getBranches(repo.root);
    const items: (vscode.QuickPickItem & { ref?: string })[] = [
      { label: '$(git-branch) Current (HEAD)', description: 'default', ref: undefined },
      { label: '$(list-unordered) All Branches', description: 'local and remote', ref: '--all' },
      ...branches.local.map((b) => ({
        label: b,
        description: b === branches.current ? 'current branch' : 'local',
        ref: b,
      })),
      ...branches.remote.map((b) => ({ label: b, description: 'remote', ref: b })),
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select branch scope' });
    if (!pick) {
      return;
    }
    history.setBranchFilter(pick.ref);
  } else if (mode.mode === 'author') {
    const value = await pickAuthor(repo.root, history.getFilters());
    if (value === undefined) {
      return; // Cancelled.
    }
    history.setTextFilter('author', value.trim() || undefined);
  } else {
    const value = await vscode.window.showInputBox({
      prompt: 'Search commit messages (substring, case-insensitive)',
      value: history.getFilters().message ?? '',
      placeHolder: 'e.g. fix login',
    });
    if (value === undefined) {
      return; // Cancelled; an empty string clears the filter.
    }
    history.setTextFilter('message', value.trim() || undefined);
  }
  updateHistoryMeta();
}

interface AuthorPickItem extends vscode.QuickPickItem {
  value?: string;
  custom?: boolean;
}

/** Author picker with completion from the repo history; free text stays possible. */
async function pickAuthor(repoRoot: string, filters: LogFilter): Promise<string | undefined> {
  const authors = await getAuthors(repoRoot, filters.ref ?? 'HEAD');
  return new Promise<string | undefined>((resolve) => {
    const qp = vscode.window.createQuickPick<AuthorPickItem>();
    qp.placeholder = 'Select an author, or type a custom substring filter';
    qp.matchOnDescription = true; // Typing also matches emails and counts.
    const authorItems: AuthorPickItem[] = authors.map((a) => ({
      label: a.name,
      description: `${a.email} • ${a.commits} commit${a.commits === 1 ? '' : 's'}`,
      value: a.email,
    }));
    const customItem: AuthorPickItem = {
      label: '',
      description: 'Custom substring filter',
      alwaysShow: true,
      custom: true,
    };
    qp.items = authorItems;
    const current = filters.author;
    if (current) {
      const match = authorItems.find((i) => i.value === current);
      if (match) {
        qp.activeItems = [match];
      } else {
        qp.value = current;
      }
    }
    qp.onDidChangeValue((v) => {
      const text = v.trim();
      if (text) {
        customItem.label = `$(search) Use "${text}"`;
        qp.items = [customItem, ...authorItems];
      } else {
        qp.items = authorItems;
      }
    });
    qp.onDidAccept(() => {
      const item = qp.activeItems[0];
      resolve(item?.custom ? qp.value.trim() : item?.value);
      qp.hide();
    });
    qp.onDidHide(() => {
      resolve(undefined);
      qp.dispose();
    });
    qp.show();
  });
}

async function fetchAll(tree: RepoTreeProvider, log: LogFn): Promise<void> {
  const items = tree.getItems();
  if (items.length === 0) {
    void vscode.window.showInformationMessage('Git Repos: no repositories found.');
    return;
  }
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: 'Git Repos: fetching all repositories',
    },
    async (progress) => {
      let done = 0;
      let failed = 0;
      await Promise.all(
        items.map(async (item) => {
          try {
            await git(item.repo.root, ['fetch', '--prune'], log);
          } catch (err) {
            failed++;
            const message = err instanceof Error ? err.message : String(err);
            log(`Fetch failed for ${item.repo.root}: ${message}`);
          }
          done++;
          progress.report({
            message: `${done}/${items.length}`,
            increment: 100 / items.length,
          });
        }),
      );
      if (failed > 0) {
        void vscode.window.showWarningMessage(
          `Git Repos: fetch completed with ${failed} error(s). See the "Git Repos Manager" output.`,
        );
      }
    },
  );
  await tree.refresh();
}
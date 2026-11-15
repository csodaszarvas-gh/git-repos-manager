import * as vscode from 'vscode';
import * as path from 'path';
import { git, LogFn } from './git';
import { Repository } from './repoScanner';
import { FileItem, GroupItem, RepoItem, RepoTreeProvider } from './reposTree';
import { DIFF_SCHEME } from './diffProvider';

export function registerCommands(
  context: vscode.ExtensionContext,
  tree: RepoTreeProvider,
  log: LogFn,
): void {
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
      commit(item, tree, log, false),
    ),
    vscode.commands.registerCommand('gitReposManager.commitAll', (item?: RepoItem) =>
      commit(item, tree, log, true),
    ),
    vscode.commands.registerCommand('gitReposManager.openChanges', (item?: FileItem) =>
      openChanges(item),
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
  item: RepoItem | undefined,
  tree: RepoTreeProvider,
  log: LogFn,
  stageAllChanges: boolean,
): Promise<void> {
  if (!item) {
    return;
  }
  if (stageAllChanges && item.changeCount === 0) {
    void vscode.window.showInformationMessage(`Nothing to commit in ${item.repo.name}.`);
    return;
  }
  if (!stageAllChanges && (item.status?.staged ?? 0) === 0) {
    void vscode.window.showWarningMessage(
      `No staged changes in ${item.repo.name}. Stage files first, or use "Stage All & Commit".`,
    );
    return;
  }
  const message = await vscode.window.showInputBox({
    prompt: `Commit message for ${item.repo.name}${stageAllChanges ? ' (all changes will be staged)' : ''}`,
    placeHolder: 'Commit message',
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : 'A commit message is required.'),
  });
  if (!message) {
    return;
  }
  const steps: string[][] = [];
  if (stageAllChanges) {
    steps.push(['add', '-A']);
  }
  steps.push(['commit', '-m', message]);
  const ok = await runGitSteps(item.repo, steps, 'Commit', tree, log);
  if (ok) {
    void vscode.window.showInformationMessage(`Committed in ${item.repo.name}.`);
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
    vscode.Uri.from({
      scheme: DIFF_SCHEME,
      path: fileUri.path,
      query: new URLSearchParams({
        root: item.repo.root,
        ref,
        path: item.change.path,
      }).toString(),
    });
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
import * as vscode from 'vscode';
import { getStashes, LogFn, StashEntry } from './git';
import { timeAgo } from './historyTree';
import { Repository } from './repoScanner';

export class StashItem extends vscode.TreeItem {
  constructor(
    public readonly repo: Repository,
    public readonly stash: StashEntry,
  ) {
    // Stashes are leaf items here; clicking loads the stash's files into the
    // bottom-panel Changed Files tab.
    super(stash.message || '(no message)', vscode.TreeItemCollapsibleState.None);
    this.id = stash.hash;
    this.contextValue = 'stash';
    this.description =
      `stash@{${stash.index}}` +
      `${stash.branch ? ` • ${stash.branch}` : ''} • ${timeAgo(stash.dateIso)}`;
    this.tooltip = [
      stash.message || '(no message)',
      '',
      `Stash: stash@{${stash.index}}`,
      `Commit: ${stash.hash}`,
      stash.branch ? `Branch: ${stash.branch}` : 'Branch: unknown',
      `Date: ${stash.dateIso ? new Date(stash.dateIso).toLocaleString() : 'unknown'}`,
    ].join('\n');
    this.iconPath = new vscode.ThemeIcon('archive');
    this.command = {
      command: 'gitReposManager.showStashFiles',
      title: 'Show Stash Files',
      arguments: [this],
    };
  }
}

/** Stash list of the repository currently selected in the Repositories view. */
export class StashesProvider implements vscode.TreeDataProvider<StashItem> {
  private readonly emitter = new vscode.EventEmitter<StashItem | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private repo: Repository | undefined;
  private stashes: StashEntry[] = [];
  private refreshing = false;

  constructor(private readonly log: LogFn) {}

  getRepo(): Repository | undefined {
    return this.repo;
  }

  getCount(): number {
    return this.stashes.length;
  }

  setRepo(repo: Repository | undefined): void {
    if (repo?.root === this.repo?.root) {
      return;
    }
    this.repo = repo;
    this.stashes = [];
    void vscode.commands.executeCommand('setContext', 'gitReposManager.stashesHasRepo', !!repo);
    this.emitter.fire();
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.repo || this.refreshing) {
      return;
    }
    this.refreshing = true;
    try {
      this.stashes = await getStashes(this.repo.root);
      await vscode.commands.executeCommand(
        'setContext',
        'gitReposManager.stashCount',
        this.stashes.length,
      );
      this.emitter.fire();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Stash refresh failed for ${this.repo.root}: ${message}`);
    } finally {
      this.refreshing = false;
    }
  }

  getTreeItem(element: StashItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: StashItem): StashItem[] {
    if (!this.repo || element) {
      return [];
    }
    return this.stashes.map((s) => new StashItem(this.repo!, s));
  }
}
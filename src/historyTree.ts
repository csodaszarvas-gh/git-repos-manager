import * as vscode from 'vscode';
import * as path from 'path';
import { CommitFileChange, CommitInfo, getLog, LogFilter, LogFn } from './git';
import { Repository } from './repoScanner';

export class CommitItem extends vscode.TreeItem {
  constructor(
    public readonly repo: Repository,
    public readonly commit: CommitInfo,
  ) {
    // Commits are leaf items here; clicking loads the commit's files into the
    // bottom-panel Changed Files tab instead of expanding inline.
    super(commit.subject, vscode.TreeItemCollapsibleState.None);
    this.id = commit.hash;
    this.contextValue = 'commit';
    this.command = {
      command: 'gitReposManager.showChangedFiles',
      title: 'Show Changed Files',
      arguments: [this],
    };
    this.description = `${commit.shortHash} • ${timeAgo(commit.dateIso)}`;
    this.tooltip = [
      commit.subject,
      '',
      `Commit: ${commit.hash}`,
      `Author: ${commit.authorName} <${commit.authorEmail}>`,
      `Date: ${new Date(commit.dateIso).toLocaleString()}`,
      commit.parents.length > 0
        ? `Parents: ${commit.parents.map((p) => p.slice(0, 8)).join(', ')}`
        : 'Root commit',
    ].join('\n');
    this.iconPath = new vscode.ThemeIcon('git-commit');
  }
}

export class CommitFileItem extends vscode.TreeItem {
  constructor(
    public readonly repo: Repository,
    public readonly commit: CommitInfo,
    public readonly change: CommitFileChange,
  ) {
    super(path.basename(change.path), vscode.TreeItemCollapsibleState.None);
    this.id = `${commit.hash}::${change.path}`;
    this.contextValue = 'commitFile';
    const dir = path.dirname(change.path);
    this.description = `${dir === '.' ? '' : `${dir}  `}${change.status}`;
    this.resourceUri = vscode.Uri.file(path.join(repo.root, change.path));
    this.tooltip =
      `${change.path}${change.origPath ? ` (from ${change.origPath})` : ''}\n` +
      `${change.status} in ${commit.shortHash}`;
    this.command = {
      command: 'gitReposManager.openCommitFile',
      title: 'Open Changes',
      arguments: [this],
    };
  }
}

export class LoadMoreItem extends vscode.TreeItem {
  constructor() {
    super('Load More...', vscode.TreeItemCollapsibleState.None);
    this.id = 'loadMore';
    this.contextValue = 'loadMore';
    this.iconPath = new vscode.ThemeIcon('ellipsis');
    this.command = {
      command: 'gitReposManager.loadMoreHistory',
      title: 'Load More Commits',
    };
  }
}

export type HistoryItem = CommitItem | CommitFileItem | LoadMoreItem;

/** Commit history of the repository currently selected in the Repositories view. */
export class HistoryProvider implements vscode.TreeDataProvider<HistoryItem> {
  private readonly emitter = new vscode.EventEmitter<HistoryItem | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private repo: Repository | undefined;
  private commits: CommitInfo[] = [];
  private filters: LogFilter = {};
  private loadedCount = 0;
  private mayHaveMore = false;
  private lastOid: string | undefined;
  private refreshing = false;

  constructor(private readonly log: LogFn) {}

  getRepo(): Repository | undefined {
    return this.repo;
  }

  getFilters(): LogFilter {
    return { ...this.filters };
  }

  setTextFilter(kind: 'message' | 'author', value: string | undefined): void {
    this.filters = { ...this.filters, [kind]: value };
    this.loadedCount = this.pageSize();
    void this.refresh();
  }

  setBranchFilter(ref: string | undefined): void {
    this.filters = { ...this.filters, ref };
    this.loadedCount = this.pageSize();
    void this.refresh();
  }

  clearFilters(): void {
    this.filters = {};
    this.loadedCount = this.pageSize();
    void this.refresh();
  }

  setRepo(repo: Repository | undefined): void {
    if (repo?.root === this.repo?.root) {
      return;
    }
    this.repo = repo;
    this.filters = {};
    this.loadedCount = this.pageSize();
    this.commits = [];
    this.lastOid = undefined;
    void vscode.commands.executeCommand('setContext', 'gitReposManager.historyHasRepo', !!repo);
    this.emitter.fire();
    void this.refresh();
  }

  /** Refresh when the repository HEAD moved (e.g. after a commit or checkout). */
  syncOid(oid: string | undefined): void {
    // With a branch filter active, the shown history is not HEAD's.
    if (!this.repo || this.filters.ref || oid === this.lastOid) {
      return;
    }
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.repo || this.refreshing) {
      return;
    }
    this.refreshing = true;
    try {
      this.commits = await getLog(this.repo.root, this.loadedCount, this.filters);
      this.mayHaveMore = this.commits.length >= this.loadedCount;
      this.lastOid = this.commits[0]?.hash;
      await vscode.commands.executeCommand(
        'setContext',
        'gitReposManager.historyCommitCount',
        this.commits.length,
      );
      this.emitter.fire();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`History refresh failed for ${this.repo.root}: ${message}`);
    } finally {
      this.refreshing = false;
    }
  }

  loadMore(): void {
    this.loadedCount += this.pageSize();
    void this.refresh();
  }

  private pageSize(): number {
    return vscode.workspace.getConfiguration('gitReposManager').get<number>('historyPageSize', 50);
  }

  getTreeItem(element: HistoryItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: HistoryItem): Promise<HistoryItem[]> {
    if (!this.repo || element) {
      // Commits are leaf items; their files are shown in the panel.
      return [];
    }
    const items: HistoryItem[] = this.commits.map((c) => new CommitItem(this.repo!, c));
    if (this.mayHaveMore) {
      items.push(new LoadMoreItem());
    }
    return items;
  }
}

export function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days}d`;
  }
  const months = Math.floor(days / 30);
  if (months < 12) {
    return `${months}mo`;
  }
  return `${Math.floor(months / 12)}y`;
}
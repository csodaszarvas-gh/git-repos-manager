import * as vscode from 'vscode';
import * as path from 'path';
import { CommitFileChange, CommitInfo, getCommitFiles, getLog, LogFn } from './git';
import { Repository } from './repoScanner';

export class CommitItem extends vscode.TreeItem {
  constructor(
    public readonly repo: Repository,
    public readonly commit: CommitInfo,
  ) {
    super(commit.subject, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = commit.hash;
    this.contextValue = 'commit';
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
  private loadedCount = 0;
  private mayHaveMore = false;
  private lastOid: string | undefined;
  private refreshing = false;
  private readonly fileCache = new Map<string, CommitFileChange[]>();

  constructor(private readonly log: LogFn) {}

  getRepo(): Repository | undefined {
    return this.repo;
  }

  setRepo(repo: Repository | undefined): void {
    if (repo?.root === this.repo?.root) {
      return;
    }
    this.repo = repo;
    this.loadedCount = this.pageSize();
    this.fileCache.clear();
    this.commits = [];
    this.lastOid = undefined;
    void vscode.commands.executeCommand('setContext', 'gitReposManager.historyHasRepo', !!repo);
    this.emitter.fire();
    void this.refresh();
  }

  /** Refresh when the repository HEAD moved (e.g. after a commit or checkout). */
  syncOid(oid: string | undefined): void {
    if (!this.repo || oid === this.lastOid) {
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
      this.commits = await getLog(this.repo.root, this.loadedCount);
      this.mayHaveMore = this.commits.length >= this.loadedCount;
      this.lastOid = this.commits[0]?.hash;
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
    if (!this.repo) {
      return [];
    }
    if (!element) {
      const items: HistoryItem[] = this.commits.map((c) => new CommitItem(this.repo!, c));
      if (this.mayHaveMore) {
        items.push(new LoadMoreItem());
      }
      return items;
    }
    if (element instanceof CommitItem) {
      let files = this.fileCache.get(element.commit.hash);
      if (!files) {
        files = await getCommitFiles(
          element.repo.root,
          element.commit.hash,
          element.commit.parents.length === 0,
        ).catch(() => []);
        this.fileCache.set(element.commit.hash, files);
      }
      return files.map((f) => new CommitFileItem(element.repo, element.commit, f));
    }
    return [];
  }
}

function timeAgo(iso: string): string {
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
import * as vscode from 'vscode';
import * as path from 'path';
import { Repository, scanRepositories } from './repoScanner';
import { FileChange, getLastCommit, getStatus, GroupKind, LogFn, RepoStatus } from './git';

export type { GroupKind } from './git';

const GROUP_LABELS: Record<GroupKind, string> = {
  staged: 'Staged Changes',
  changes: 'Changes',
  untracked: 'Untracked',
  conflicts: 'Merge Conflicts',
};

export class RepoItem extends vscode.TreeItem {
  constructor(
    public readonly repo: Repository,
    public readonly status: RepoStatus | undefined,
    public readonly lastCommit: string | undefined,
    public readonly error: string | undefined,
    workspaceFolderCount: number,
  ) {
    // File-level details live in the bottom-panel Working Tree tab; the
    // sidebar stays a clean repository list.
    super(RepoItem.labelFor(repo, workspaceFolderCount), vscode.TreeItemCollapsibleState.None);
    this.id = repo.root;
    this.contextValue = 'repo';
    this.description = this.buildDescription();
    this.tooltip = this.buildTooltip();
    this.iconPath = this.buildIcon();
  }

  get changeCount(): number {
    if (!this.status) {
      return 0;
    }
    return (
      this.status.staged + this.status.unstaged + this.status.untracked + this.status.conflicted
    );
  }

  get isDirty(): boolean {
    return this.changeCount > 0;
  }

  private static labelFor(repo: Repository, workspaceFolderCount: number): string {
    let label =
      repo.relativePath === '.' ? repo.name : repo.relativePath.replace(/\\/g, '/');
    if (workspaceFolderCount > 1) {
      label = `${repo.workspaceFolder}/${label}`;
    }
    return label;
  }

  private buildDescription(): string {
    if (this.error) {
      return 'status unavailable';
    }
    if (!this.status) {
      return '';
    }
    const parts: string[] = [this.status.branch ?? 'detached'];
    if (this.status.upstream) {
      const sync = [
        this.status.ahead > 0 ? `↑${this.status.ahead}` : '',
        this.status.behind > 0 ? `↓${this.status.behind}` : '',
      ]
        .filter(Boolean)
        .join('');
      if (sync) {
        parts.push(sync);
      }
    }
    if (this.changeCount > 0) {
      parts.push(`${this.changeCount} changed`);
    }
    return parts.join('  ');
  }

  private buildTooltip(): string {
    const lines = [this.repo.root];
    if (this.error) {
      lines.push(`Error: ${this.error}`);
      return lines.join('\n');
    }
    if (this.status) {
      lines.push(`Branch: ${this.status.branch ?? `detached at ${this.status.oid?.slice(0, 8) ?? 'unknown'}`}`);
      if (this.status.upstream) {
        lines.push(`Upstream: ${this.status.upstream} (ahead ${this.status.ahead}, behind ${this.status.behind})`);
      } else {
        lines.push('No upstream configured');
      }
      lines.push(
        `Changes: ${this.status.staged} staged, ${this.status.unstaged} unstaged, ` +
          `${this.status.untracked} untracked, ${this.status.conflicted} conflicted`,
      );
    }
    if (this.lastCommit) {
      lines.push(`Last commit: ${this.lastCommit}`);
    }
    return lines.join('\n');
  }

  private buildIcon(): vscode.ThemeIcon {
    if (this.error) {
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('errorForeground'));
    }
    if (this.status && this.status.conflicted > 0) {
      return new vscode.ThemeIcon('git-branch', new vscode.ThemeColor('errorForeground'));
    }
    if (this.isDirty) {
      return new vscode.ThemeIcon(
        'git-branch',
        new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
      );
    }
    return new vscode.ThemeIcon('git-branch');
  }
}

export class GroupItem extends vscode.TreeItem {
  constructor(
    public readonly repo: Repository,
    public readonly kind: GroupKind,
    public readonly files: FileChange[],
  ) {
    super(GROUP_LABELS[kind], vscode.TreeItemCollapsibleState.Expanded);
    this.id = `${repo.root}::${kind}`;
    this.contextValue = `${kind}Group`;
    this.description = String(files.length);
  }
}

export class FileItem extends vscode.TreeItem {
  constructor(
    public readonly repo: Repository,
    public readonly kind: GroupKind,
    public readonly change: FileChange,
    wide = false,
  ) {
    super(wide ? change.path : path.basename(change.path), vscode.TreeItemCollapsibleState.None);
    this.id = `${repo.root}::${kind}::${change.path}`;
    this.contextValue = `${kind}File`;
    const dir = path.dirname(change.path);
    const letter =
      this.kind === 'untracked' ? 'U' : this.kind === 'conflicts' ? '!' : this.kind === 'staged' ? change.x : change.y;
    this.description = wide ? letter : `${dir === '.' ? '' : `${dir}  `}${letter}`;
    this.resourceUri = vscode.Uri.file(path.join(repo.root, change.path));
    this.tooltip =
      `${change.path}${change.origPath ? ` (renamed from ${change.origPath})` : ''}\n` +
      GROUP_LABELS[kind];
    this.command = {
      command: 'gitReposManager.openChanges',
      title: 'Open Changes',
      arguments: [this],
    };
  }
}

export type AnyItem = RepoItem | GroupItem | FileItem;

export class RepoTreeProvider implements vscode.TreeDataProvider<AnyItem> {
  private readonly emitter = new vscode.EventEmitter<AnyItem | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private items: RepoItem[] = [];
  private refreshing = false;

  constructor(private readonly log: LogFn) {}

  getItems(): readonly RepoItem[] {
    return this.items;
  }

  getStats(): { total: number; dirty: number } {
    return {
      total: this.items.length,
      dirty: this.items.filter((item) => item.isDirty).length,
    };
  }

  async refresh(): Promise<void> {
    if (this.refreshing) {
      return;
    }
    this.refreshing = true;
    try {
      const repos = await scanRepositories(this.log);
      const workspaceFolderCount = vscode.workspace.workspaceFolders?.length ?? 0;
      const items = await Promise.all(
        repos.map(async (repo) => {
          try {
            const status = await getStatus(repo.root);
            const lastCommit = await getLastCommit(repo.root);
            return new RepoItem(repo, status, lastCommit, undefined, workspaceFolderCount);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.log(`Failed to read status of ${repo.root}: ${message}`);
            return new RepoItem(repo, undefined, undefined, message, workspaceFolderCount);
          }
        }),
      );
      items.sort((a, b) =>
        `${a.repo.workspaceFolder}/${a.repo.relativePath}`.localeCompare(
          `${b.repo.workspaceFolder}/${b.repo.relativePath}`,
        ),
      );
      this.items = items;
      await vscode.commands.executeCommand('setContext', 'gitReposManager.repoCount', items.length);
      this.emitter.fire();
    } finally {
      this.refreshing = false;
    }
  }

  getTreeItem(element: AnyItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: AnyItem): AnyItem[] {
    // Repositories are leaf items here; groups/files are shown in the panel.
    return element ? [] : this.items;
  }
}
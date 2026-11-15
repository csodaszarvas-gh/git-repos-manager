import * as vscode from 'vscode';
import { filesForGroup, getStatus, LogFn, RepoStatus } from './git';
import { Repository } from './repoScanner';
import { FileItem, GroupItem } from './reposTree';

type WorkingItem = GroupItem | FileItem;

/**
 * Wide, panel-friendly view of the selected repository's working tree changes.
 * Mirrors the sidebar groups (Staged / Changes / Untracked / Conflicts) but
 * shows full relative paths, and is the default tab of the bottom panel.
 */
export class WorkingTreeProvider implements vscode.TreeDataProvider<WorkingItem> {
  private readonly emitter = new vscode.EventEmitter<WorkingItem | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private repo: Repository | undefined;
  private status: RepoStatus | undefined;
  private refreshing = false;

  constructor(private readonly log: LogFn) {}

  getRepo(): Repository | undefined {
    return this.repo;
  }

  getChangeCount(): number {
    return this.status?.files.length ?? 0;
  }

  setRepo(repo: Repository | undefined): void {
    if (repo?.root === this.repo?.root) {
      return;
    }
    this.repo = repo;
    this.status = undefined;
    void vscode.commands.executeCommand(
      'setContext',
      'gitReposManager.workingTreeHasRepo',
      Boolean(repo),
    );
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.refreshing) {
      return;
    }
    this.refreshing = true;
    try {
      if (this.repo) {
        try {
          this.status = await getStatus(this.repo.root);
        } catch (err) {
          this.status = undefined;
          const message = err instanceof Error ? err.message : String(err);
          this.log(`Failed to read working tree of ${this.repo.root}: ${message}`);
        }
      } else {
        this.status = undefined;
      }
      await vscode.commands.executeCommand(
        'setContext',
        'gitReposManager.workingTreeCount',
        this.getChangeCount(),
      );
      this.emitter.fire();
    } finally {
      this.refreshing = false;
    }
  }

  getTreeItem(element: WorkingItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: WorkingItem): WorkingItem[] {
    if (!this.repo || !this.status) {
      return [];
    }
    if (!element) {
      const groups: GroupItem[] = [];
      for (const kind of ['staged', 'changes', 'untracked', 'conflicts'] as const) {
        const files = filesForGroup(this.status, kind);
        if (files.length > 0) {
          groups.push(new GroupItem(this.repo, kind, files));
        }
      }
      return groups;
    }
    if (element instanceof GroupItem) {
      return element.files.map(
        (change) => new FileItem(element.repo, element.kind, change, true),
      );
    }
    return [];
  }
}
import * as vscode from 'vscode';
import * as path from 'path';
import { CommitInfo, getCommitFiles, LogFn } from './git';
import { Repository } from './repoScanner';

export interface CombinedFile {
  path: string;
  origPath?: string;
  /** One entry per selected commit that touched this file, oldest first. */
  entries: { commit: CommitInfo; status: string }[];
}

export class CombinedFileItem extends vscode.TreeItem {
  constructor(
    public readonly repo: Repository,
    public readonly file: CombinedFile,
  ) {
    // Full relative path as label: the bottom panel is wide enough (JetBrains-style).
    super(file.path, vscode.TreeItemCollapsibleState.None);
    this.id = file.path;
    this.contextValue = 'combinedFile';
    const statuses = [...new Set(file.entries.map((e) => e.status))].join('');
    this.description =
      file.entries.length > 1 ? `${statuses} • ${file.entries.length} commits` : statuses;
    this.resourceUri = vscode.Uri.file(path.join(repo.root, file.path));
    this.tooltip = [
      `${file.path}${file.origPath ? ` (from ${file.origPath})` : ''}`,
      ...file.entries.map((e) => `${e.commit.shortHash} (${e.status}) ${e.commit.subject}`),
    ].join('\n');
    this.command = {
      command: 'gitReposManager.openCombinedFile',
      title: 'Open Changes',
      arguments: [this],
    };
  }
}

/**
 * Union of the files changed by the commits selected in the History view,
 * shown in the bottom panel for a wide, JetBrains-log-like display.
 */
export class ChangedFilesProvider implements vscode.TreeDataProvider<CombinedFileItem> {
  private readonly emitter = new vscode.EventEmitter<CombinedFileItem | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private items: CombinedFileItem[] = [];

  constructor(private readonly log: LogFn) {}

  getTreeItem(element: CombinedFileItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: CombinedFileItem): CombinedFileItem[] {
    return element ? [] : this.items;
  }

  /** Replace the content with the union of changed files; returns the file count. */
  async setCommits(repo: Repository | undefined, commits: CommitInfo[]): Promise<number> {
    if (!repo || commits.length === 0) {
      this.items = [];
      this.emitter.fire();
      return 0;
    }
    const perCommit = await Promise.all(
      commits.map(async (commit) => {
        const files = await getCommitFiles(
          repo.root,
          commit.hash,
          commit.parents.length === 0,
        ).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          this.log(`Failed to read files of ${commit.shortHash}: ${message}`);
          return [];
        });
        return { commit, files };
      }),
    );
    const union = new Map<string, CombinedFile>();
    for (const { commit, files } of perCommit) {
      for (const f of files) {
        const entry = union.get(f.path) ?? { path: f.path, entries: [] };
        entry.entries.push({ commit, status: f.status });
        if (f.origPath) {
          entry.origPath = f.origPath;
        }
        union.set(f.path, entry);
      }
    }
    const combined = [...union.values()].sort((a, b) => a.path.localeCompare(b.path));
    for (const f of combined) {
      f.entries.sort((a, b) => a.commit.dateIso.localeCompare(b.commit.dateIso));
    }
    this.items = combined.map((f) => new CombinedFileItem(repo, f));
    this.emitter.fire();
    return this.items.length;
  }
}
import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as path from 'path';
import { LogFn } from './git';

export interface Repository {
  /** Absolute path of the repository root. */
  root: string;
  /** Directory name of the repository root. */
  name: string;
  /** Name of the workspace folder containing the repository. */
  workspaceFolder: string;
  /** Path relative to the workspace folder, '.' for the folder itself. */
  relativePath: string;
}

/**
 * Scan every workspace folder for Git repositories, up to the configured depth.
 * A directory containing a `.git` entry (directory or file, i.e. worktrees and
 * submodules) is treated as a repository root; its subdirectories are not scanned.
 */
export async function scanRepositories(log: LogFn): Promise<Repository[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const config = vscode.workspace.getConfiguration('gitReposManager');
  const maxDepth = config.get<number>('scanDepth', 3);
  const exclude = new Set(config.get<string[]>('excludeFolders', []));
  const found = new Map<string, Repository>();

  for (const folder of folders) {
    await walk(folder.uri.fsPath, folder.uri.fsPath, 0, folder.name);
  }

  async function walk(
    workspaceRoot: string,
    dir: string,
    depth: number,
    folderName: string,
  ): Promise<void> {
    if (await isGitRepo(dir)) {
      found.set(dir, {
        root: dir,
        name: path.basename(dir),
        workspaceFolder: folderName,
        relativePath: path.relative(workspaceRoot, dir) || '.',
      });
      return;
    }
    if (depth >= maxDepth) {
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // Unreadable directory: skip it silently.
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }
      if (entry.name.startsWith('.') || exclude.has(entry.name)) {
        continue;
      }
      await walk(workspaceRoot, path.join(dir, entry.name), depth + 1, folderName);
    }
  }

  log(`Scan found ${found.size} repositories in ${folders.length} workspace folder(s).`);
  return [...found.values()];
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await fs.stat(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}
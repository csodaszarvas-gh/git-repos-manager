import * as vscode from 'vscode';
import * as path from 'path';
import { git } from './git';

export const DIFF_SCHEME = 'gitReposManager';

/** Build a URI served by GitDiffProvider for the given repository, file and ref. */
export function makeRefUri(repoRoot: string, relPath: string, ref: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: DIFF_SCHEME,
    path: vscode.Uri.file(path.join(repoRoot, relPath)).path,
    query: new URLSearchParams({ root: repoRoot, ref, path: relPath }).toString(),
  });
}

/**
 * Serves Git blob contents for diff views. The URI query carries:
 * - root: absolute repository path
 * - ref: 'HEAD', 'index' (stage 0) or 'empty'
 * - path: file path relative to the repository root
 */
export class GitDiffProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query);
    const root = params.get('root');
    const ref = params.get('ref');
    const rel = params.get('path');
    if (!root || !ref || !rel || ref === 'empty') {
      return '';
    }
    const spec = ref === 'index' ? `:${rel}` : `${ref}:${rel}`;
    try {
      return await git(root, ['show', spec]);
    } catch {
      // No such blob (e.g. file newly added in the index, or deleted from it).
      return '';
    }
  }
}
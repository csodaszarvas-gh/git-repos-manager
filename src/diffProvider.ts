import * as vscode from 'vscode';
import { git } from './git';

export const DIFF_SCHEME = 'gitReposManager';

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
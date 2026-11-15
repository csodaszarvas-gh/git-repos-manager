import { execFile } from 'child_process';

export interface RepoStatus {
  /** Current branch name, undefined when HEAD is detached. */
  branch: string | undefined;
  /** Current commit OID, undefined for an unborn branch. */
  oid: string | undefined;
  /** Upstream tracking branch, if configured. */
  upstream: string | undefined;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  /** File-level entries behind the counters above. */
  files: FileChange[];
}

export interface FileChange {
  /** Path relative to the repository root (forward slashes). */
  path: string;
  /** Original path for renames/copies. */
  origPath?: string;
  /** Index status letter ('.' when unchanged in the index). */
  x: string;
  /** Working tree status letter ('.' when unchanged in the working tree). */
  y: string;
  untracked: boolean;
  conflicted: boolean;
}

export type LogFn = (message: string) => void;

/** Run a git command in the given directory and return its stdout. */
export function git(cwd: string, args: string[], log?: LogFn): Promise<string> {
  return new Promise((resolve, reject) => {
    log?.(`> git ${args.join(' ')}  (cwd: ${cwd})`);
    execFile(
      'git',
      args,
      { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (stderr.trim()) {
          log?.(stderr.trim());
        }
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** Read the full status of a repository with a single git call (porcelain v2). */
export async function getStatus(cwd: string): Promise<RepoStatus> {
  const out = await git(cwd, ['status', '--porcelain=v2', '--branch']);
  const status: RepoStatus = {
    branch: undefined,
    oid: undefined,
    upstream: undefined,
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    files: [],
  };

  for (const line of out.split('\n')) {
    if (!line) {
      continue;
    }
    if (line.startsWith('# branch.oid ')) {
      const value = line.slice(13);
      status.oid = value === '(initial)' ? undefined : value;
    } else if (line.startsWith('# branch.head ')) {
      const value = line.slice(14);
      status.branch = value === '(detached)' ? undefined : value;
    } else if (line.startsWith('# branch.upstream ')) {
      status.upstream = line.slice(18);
    } else if (line.startsWith('# branch.ab ')) {
      const match = line.match(/\+(\d+) -(\d+)/);
      if (match) {
        status.ahead = Number(match[1]);
        status.behind = Number(match[2]);
      }
    } else if (line.startsWith('1 ')) {
      // Ordinary entry: "1 XY sub mH mI mW hH hI path".
      const parts = line.split(' ');
      const xy = parts[1];
      if (xy[0] !== '.') {
        status.staged++;
      }
      if (xy[1] !== '.') {
        status.unstaged++;
      }
      status.files.push({
        path: parts.slice(8).join(' '),
        x: xy[0],
        y: xy[1],
        untracked: false,
        conflicted: false,
      });
    } else if (line.startsWith('2 ')) {
      // Renamed/copied entry: "2 XY sub mH mI mW hH hI Xscore path\torigPath".
      // Note the extra Xscore field: the path starts at field 9, not 8.
      const parts = line.split(' ');
      const xy = parts[1];
      if (xy[0] !== '.') {
        status.staged++;
      }
      if (xy[1] !== '.') {
        status.unstaged++;
      }
      const [filePath, origPath] = parts.slice(9).join(' ').split('\t');
      status.files.push({
        path: filePath,
        origPath,
        x: xy[0],
        y: xy[1],
        untracked: false,
        conflicted: false,
      });
    } else if (line.startsWith('u ')) {
      // Unmerged entry: "u XY sub m1 m2 m3 mW h1 h2 h3 path".
      const parts = line.split(' ');
      status.conflicted++;
      status.files.push({
        path: parts.slice(10).join(' '),
        x: parts[1][0],
        y: parts[1][1],
        untracked: false,
        conflicted: true,
      });
    } else if (line.startsWith('? ')) {
      status.untracked++;
      status.files.push({
        path: line.slice(2),
        x: '.',
        y: '.',
        untracked: true,
        conflicted: false,
      });
    }
  }

  return status;
}

/** Subject of the latest commit, undefined when the repository has no commits yet. */
export async function getLastCommit(cwd: string): Promise<string | undefined> {
  try {
    const out = await git(cwd, ['log', '-1', '--pretty=format:%s']);
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  authorName: string;
  authorEmail: string;
  /** Author date, strict ISO 8601. */
  dateIso: string;
  subject: string;
  parents: string[];
}

export interface CommitFileChange {
  path: string;
  /** Original path for renames/copies. */
  origPath?: string;
  /** Status letter: A, M, D, R, C, T... */
  status: string;
}

export type GroupKind = 'staged' | 'changes' | 'untracked' | 'conflicts';

/** Files belonging to a status group, in porcelain order. */
export function filesForGroup(status: RepoStatus, kind: GroupKind): FileChange[] {
  switch (kind) {
    case 'staged':
      return status.files.filter((f) => !f.untracked && !f.conflicted && f.x !== '.');
    case 'changes':
      return status.files.filter((f) => !f.untracked && !f.conflicted && f.y !== '.');
    case 'untracked':
      return status.files.filter((f) => f.untracked);
    case 'conflicts':
      return status.files.filter((f) => f.conflicted);
  }
}

const LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%P';

export interface LogFilter {
  /** Case-insensitive fixed-string substring of the commit message. */
  message?: string;
  /** Case-insensitive fixed-string substring of the author name/email. */
  author?: string;
  /** Branch/ref to log instead of HEAD, or '--all' for all refs. */
  ref?: string;
}

/** Latest commits, newest first. Returns [] for a repository without commits. */
export async function getLog(cwd: string, maxCount: number, filter: LogFilter = {}): Promise<CommitInfo[]> {
  const args = ['log', `--max-count=${maxCount}`, `--pretty=format:${LOG_FORMAT}`];
  if (filter.ref) {
    args.push(filter.ref);
  }
  if (filter.message) {
    args.push('-i', '-F', '--grep', filter.message);
  }
  if (filter.author) {
    args.push('-i', '-F', '--author', filter.author);
  }
  if (filter.message && filter.author) {
    args.push('--all-match');
  }
  let out: string;
  try {
    out = await git(cwd, args);
  } catch {
    return []; // Unborn branch: no commits yet.
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, shortHash, authorName, authorEmail, dateIso, subject, parents] =
        line.split('\x1f');
      return {
        hash,
        shortHash,
        authorName,
        authorEmail,
        dateIso,
        subject,
        parents: parents ? parents.split(' ') : [],
      };
    });
}

export interface BranchList {
  /** Current branch name, undefined when HEAD is detached. */
  current: string | undefined;
  local: string[];
  remote: string[];
}

/** Local and remote branches for the branch filter picker. */
export async function getBranches(cwd: string): Promise<BranchList> {
  const [localOut, remoteOut, currentOut] = await Promise.all([
    git(cwd, ['branch', '--format=%(refname:short)']),
    git(cwd, ['branch', '-r', '--format=%(refname:short)']),
    git(cwd, ['branch', '--show-current']),
  ]);
  return {
    current: currentOut.trim() || undefined,
    local: localOut.split('\n').map((s) => s.trim()).filter(Boolean),
    remote: remoteOut
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s && !s.endsWith('/HEAD')),
  };
}

export interface AuthorInfo {
  name: string;
  email: string;
  commits: number;
}

/** Authors reachable from a ref (default HEAD), most commits first. */
export async function getAuthors(cwd: string, ref = 'HEAD'): Promise<AuthorInfo[]> {
  let out: string;
  try {
    out = await git(cwd, ['shortlog', '-sne', ref]);
  } catch {
    return []; // Unborn branch: no commits yet.
  }
  const authors: AuthorInfo[] = [];
  for (const line of out.split('\n')) {
    // shortlog -sne lines: "   12\tName <email>"
    const match = /^\s*(\d+)\t(.*) <(.*)>$/.exec(line);
    if (match) {
      authors.push({ commits: Number(match[1]), name: match[2], email: match[3] });
    }
  }
  return authors;
}

/**
 * Files changed by a commit, compared against its first parent
 * (all files for a root commit). Rename entries keep the original path.
 */
export async function getCommitFiles(
  cwd: string,
  sha: string,
  isRootCommit: boolean,
): Promise<CommitFileChange[]> {
  // -M is required: plumbing diff-tree does not detect renames by default.
  const args = isRootCommit
    ? ['diff-tree', '--root', '--no-commit-id', '-r', '-M', '--name-status', sha]
    : ['diff-tree', '-r', '-M', '--name-status', `${sha}^1`, sha];
  const out = await git(cwd, args);
  const changes: CommitFileChange[] = [];
  for (const line of out.split('\n')) {
    if (!line) {
      continue;
    }
    const parts = line.split('\t');
    const status = parts[0][0];
    if (parts.length >= 3) {
      changes.push({ path: parts[2], origPath: parts[1], status });
    } else if (parts.length === 2) {
      changes.push({ path: parts[1], status });
    }
  }
  return changes;
}
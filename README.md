# Git Repos Manager

Manage multiple Git repositories found across your project directories from a single sidebar in VS Code or Qoder IDE: status, stage, commit, history, stashes, fetch, pull and push.

## Features

- Automatic discovery of Git repositories in the workspace (configurable depth and excluded folders)
- Working Tree panel: Staged / Changes / Untracked / Conflicts groups with stage, unstage and discard
- Commits from the sidebar, with a multi-line commit message box
- Commit history with search (message, author, branch), combined changed-files diffs and reset-to-commit
- Stashes view: browse, apply, pop, drop, and create stashes (tracked-only or including untracked)
- Fetch / Pull (fast-forward only) / Push per repo, Fetch All, auto-refresh on save and file changes

## Install / update (Windows)

Run this line in PowerShell — it installs the latest release, or updates an existing install:

```powershell
irm https://raw.githubusercontent.com/csodaszarvas-gh/git-repos-manager/main/install.ps1 | iex
```

It detects VS Code (`code` on PATH), VSCodium (`codium`) or Qoder IDE automatically. To force a specific CLI:

```powershell
$env:EXTENSION_CLI = 'C:\path\to\code.cmd'; irm https://raw.githubusercontent.com/csodaszarvas-gh/git-repos-manager/main/install.ps1 | iex
```

Manual alternative: download the `.vsix` from the [latest release](https://github.com/csodaszarvas-gh/git-repos-manager/releases/latest), then run `code --install-extension <file>.vsix` or use *Extensions → … → Install from VSIX…* in the IDE.

## Releasing a new version

1. Bump `version` in `package.json` and commit.
2. Tag and push: `git tag v0.16.1 && git push origin main v0.16.1`
3. GitHub Actions compiles, packages the `.vsix` and publishes the release automatically.

## Development

```bash
npm install
npm run compile   # tsc src/ -> out/
npm run package   # vsce package -> .vsix
```

## License

[MIT](LICENSE)
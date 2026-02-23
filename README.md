# github-notification-clean

CLI to cleanup GitHub PR notifications you no longer need to review. Marks notifications as done for PRs that are closed or where you are no longer a requested reviewer.

## Prerequisites

You must have the [GitHub CLI](https://cli.github.com/) installed and authenticated:

```sh
gh auth login
```

## Usage

```sh
npx github-notification-clean
```

### Options

```
-h, --help        Show help message
-v, --version     Show version number
-d, --dry-run     Preview what would be cleared without making changes
-t, --teams       Comma-separated team slugs to keep notifications for
```

### Examples

Preview what would be cleared:

```sh
npx github-notification-clean --dry-run
```

Keep notifications where specific teams are requested reviewers:

```sh
npx github-notification-clean --teams my-team,other-team
```

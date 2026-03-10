import { Octokit } from "@octokit/rest";
import { RequestError } from "@octokit/request-error";
import { execFile as nodeExecFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { createUI, bold, cyan, dim, green, red, yellow } from "./ui.ts";

declare const __VERSION__: string;
const VERSION = __VERSION__;

const execFile = promisify(nodeExecFile);

interface CliOptions {
  help: boolean;
  version: boolean;
  dryRun: boolean;
  teams: string[];
}

function printHelp(): void {
  process.stdout.write(`gh-inbox-clean v${VERSION}

Cleanup GitHub PR notifications you no longer need to review.
Marks notifications as done for PRs that are closed or where
you are no longer a requested reviewer.

Requires the GitHub CLI (gh) to be installed and authenticated.

Usage:
  npx gh-inbox-clean [options]

Options:
  -h, --help        Show this help message
  -v, --version     Show version number
  -d, --dry-run     Preview what would be cleared without making changes
  -t, --teams       Comma-separated team slugs to keep notifications for
`);
}

function parseCliArgs(): CliOptions {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
      "dry-run": { type: "boolean", short: "d", default: false },
      teams: { type: "string", short: "t", default: "" },
    },
    strict: true,
  });

  const teamsRaw = values.teams ?? "";

  return {
    help: values.help ?? false,
    version: values.version ?? false,
    dryRun: values["dry-run"] ?? false,
    teams: teamsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

interface TokenSuccess {
  succeeded: true;
  token: string;
}

interface TokenFailure {
  succeeded: false;
  error: string | undefined;
}

type TokenResult = TokenSuccess | TokenFailure;

interface PullRequestRef {
  owner: string;
  repo: string;
  pull_number: number;
}

function isRateLimitError(error: unknown): error is RequestError {
  if (!(error instanceof RequestError)) {
    return false;
  }

  if (error.status === 429) {
    return true;
  }

  if (error.status === 403) {
    const remaining = error.response?.headers?.["x-ratelimit-remaining"];
    return remaining === "0";
  }

  return false;
}

async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  onRetry?: (message: string) => void,
  maxRetries = 3,
  baseDelay = 1000,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      if (attempt === maxRetries || !isRateLimitError(error)) {
        throw error;
      }
      const retryAfter = Number(error.response?.headers?.["retry-after"]);
      const delay = !Number.isNaN(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : baseDelay * 2 ** attempt;
      const msg = `Rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`;
      if (onRetry) {
        onRetry(msg);
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("Exceeded maximum retries");
}

async function getGithubToken(): Promise<TokenResult> {
  try {
    const { stdout } = await execFile("gh", ["auth", "token"]);
    return { succeeded: true, token: stdout.trim() };
  } catch {
    try {
      await execFile("gh", ["help"]);
      return {
        succeeded: false,
        error:
          "GitHub CLI is installed but not authenticated. Run `gh auth login` first.",
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { succeeded: false, error: `Could not run \`gh\`: ${message}` };
    }
  }
}

function parsePullRequestUrl(url: string): PullRequestRef {
  const { pathname } = new URL(url);
  const parts = pathname.split("/");
  // pathname: /repos/{owner}/{repo}/pulls/{pull_number}
  const owner = parts[2];
  const repo = parts[3];
  const pull_number = Number(parts[5]);

  if (!owner || !repo || Number.isNaN(pull_number)) {
    throw new Error(`Could not parse PR URL: ${url}`);
  }

  return { owner, repo, pull_number };
}

async function getAuthenticatedLogin(github: Octokit): Promise<string> {
  try {
    const { data } = await github.users.getAuthenticated();
    return data.login;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to authenticate with GitHub. Is your token valid? Run \`gh auth login\` to re-authenticate. (${message})`,
    );
  }
}

async function main(): Promise<void> {
  const options = parseCliArgs();

  if (options.help) {
    printHelp();
    return;
  }

  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const { spinner, log } = createUI();

  try {
    const onRetry = (msg: string) => spinner.update(yellow(msg));

    spinner.start("Authenticating with GitHub...");
    const tokenResult = await getGithubToken();

    if (!tokenResult.succeeded) {
      spinner.error(tokenResult.error ?? "Failed to get GitHub token");
      process.exitCode = 1;
      return;
    }

    const github = new Octokit({ auth: tokenResult.token });
    const login = await withRateLimitRetry(
      () => getAuthenticatedLogin(github),
      onRetry,
    );
    spinner.success(`Authenticated as ${bold(login)}`);

    if (options.dryRun) {
      spinner.warning("Dry run — no notifications will be marked as done");
    }

    spinner.start("Fetching notifications...");
    const cleared: string[] = [];
    let checked = 0;

    for await (const { data: notifications } of github.paginate.iterator(
      "GET /notifications",
      { all: true },
    )) {
      for (const notification of notifications) {
        try {
          if (notification.subject.type !== "PullRequest") {
            continue;
          }

          const subjectUrl = notification.subject.url;

          if (!subjectUrl) {
            continue;
          }

          checked++;
          const { owner, repo, pull_number } = parsePullRequestUrl(subjectUrl);
          const prLabel = `${owner}/${repo}#${pull_number}`;

          spinner.update(`Checking PR ${dim(String(checked))} ${cyan(prLabel)}`);

          const { data: pr } = await withRateLimitRetry(
            () => github.pulls.get({ owner, repo, pull_number }),
            onRetry,
          );

          const isReviewer = pr.requested_reviewers?.some(
            (r) => r.login === login,
          );
          const isTeamReviewer =
            options.teams.length > 0 &&
            pr.requested_teams?.some((t) => options.teams.includes(t.slug));

          if (pr.state !== "closed" && (isReviewer || isTeamReviewer)) {
            continue;
          }

          const reason = pr.merged
            ? "merged"
            : pr.state === "closed"
              ? "closed"
              : "not a reviewer";

          if (!options.dryRun) {
            spinner.update(`Clearing ${cyan(prLabel)} ${dim(`(${reason})`)}`);
            await withRateLimitRetry(
              () =>
                github.activity.markThreadAsDone({
                  thread_id: Number(notification.id),
                }),
              onRetry,
            );
          }

          cleared.push(`${pr.html_url} ${dim(`(${reason})`)}`);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          spinner.error(`Failed to process notification ${notification.id}: ${message}`);
          spinner.start("Continuing...");
        }
      }
    }

    const suffix = options.dryRun ? dim(" (dry run)") : "";

    if (cleared.length > 0) {
      spinner.success(`${bold(String(cleared.length))} PR notifications cleared!${suffix}`);
      for (const url of cleared) {
        log.info(`  ${green("+")} ${dim(url)}`);
      }
    } else {
      spinner.info(`No PR notifications to clear.${suffix}`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    spinner.error(message);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${red(bold("error"))} ${message}\n`);
  process.exitCode = 1;
});

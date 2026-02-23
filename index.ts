import { Octokit } from "@octokit/rest";
import { RequestError } from "@octokit/request-error";
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);

const log = {
  info: (msg: string) => process.stdout.write(`${msg}\n`),
  error: (msg: string) => process.stderr.write(`${msg}\n`),
};

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
      const delay = !Number.isNaN(retryAfter)
        ? retryAfter * 1000
        : baseDelay * 2 ** attempt;
      log.info(`Rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
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

function getTeamSlugs(): string[] {
  const teams = process.env.NOTIFICATION_CLEANUP_TEAMS;
  if (!teams) {
    return [];
  }
  return teams
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main(): Promise<void> {
  const tokenResult = await getGithubToken();

  if (!tokenResult.succeeded) {
    throw new Error(tokenResult.error ?? "Failed to get GitHub token");
  }

  const github = new Octokit({ auth: tokenResult.token });
  const login = await withRateLimitRetry(() =>
    getAuthenticatedLogin(github),
  );
  const teamSlugs = getTeamSlugs();

  const cleared: string[] = [];

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

        const { owner, repo, pull_number } = parsePullRequestUrl(subjectUrl);

        const { data: pr } = await withRateLimitRetry(() =>
          github.pulls.get({ owner, repo, pull_number }),
        );

        const isReviewer = pr.requested_reviewers?.some(
          (r) => r.login === login,
        );
        const isTeamReviewer =
          teamSlugs.length > 0 &&
          pr.requested_teams?.some((t) => teamSlugs.includes(t.slug));

        if (pr.state !== "closed" && (isReviewer || isTeamReviewer)) {
          continue;
        }

        await withRateLimitRetry(() =>
          github.activity.markThreadAsDone({
            thread_id: Number(notification.id),
          }),
        );

        cleared.push(pr.html_url);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`Failed to process notification ${notification.id}: ${message}`);
      }
    }
  }

  if (cleared.length > 0) {
    log.info(cleared.join("\n"));
  }
  log.info(`${cleared.length} PR notifications cleared!`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  log.error(message);
  process.exitCode = 1;
});

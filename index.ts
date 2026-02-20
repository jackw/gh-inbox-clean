import { Octokit } from "@octokit/rest";
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);

interface TokenSuccess {
  succeeded: true;
  token: string;
}

interface TokenFailure {
  succeeded: false;
  error: string | undefined;
}

type TokenResult = TokenSuccess | TokenFailure;

async function getGithubToken(): Promise<TokenResult> {
  try {
    const { stdout } = await execFile("gh", ["auth", "token"]);
    return { succeeded: true, token: stdout.trim() };
  } catch {
    try {
      await execFile("gh", ["help"]);
      return { succeeded: false, error: undefined };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { succeeded: false, error: `Could not run \`gh\`: ${message}` };
    }
  }
}

function parsePullRequestUrl(url: string): {
  owner: string;
  repo: string;
  pull_number: number;
} {
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

const tokenResult = await getGithubToken();

if (!tokenResult.succeeded) {
  throw new Error(tokenResult.error ?? "Failed to get GitHub token");
}

const github = new Octokit({ auth: tokenResult.token });

const cleared: string[] = [];

for await (const { data: notifications } of github.paginate.iterator(
  "GET /notifications",
  {},
)) {
  for (const notification of notifications) {
    if (notification.subject.type !== "PullRequest") {
      continue;
    }

    const subjectUrl = notification.subject.url;

    if (!subjectUrl) {
      continue;
    }

    const { owner, repo, pull_number } = parsePullRequestUrl(subjectUrl);

    const { data: pr } = await github.pulls.get({
      owner,
      repo,
      pull_number,
    });

    const isReviewer = pr.requested_reviewers?.some(
      (r) => r.login === "mckn",
    );
    const isTeamReviewer = pr.requested_teams?.some(
      (t) =>
        t.slug === "plugins-platform-frontend" ||
        t.slug === "plugins-platform",
    );

    if (pr.state !== "closed" && (isReviewer || isTeamReviewer)) {
      continue;
    }

    await github.activity.markThreadAsDone({
      thread_id: Number(notification.id),
    });

    cleared.push(pr.html_url);
  }
}

console.log(cleared.join("\n"));
console.log(`${cleared.length} PR notifications cleared!`);

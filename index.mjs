import { Octokit } from "@octokit/rest";
import { exec as nodeExec } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(nodeExec);

const { token } = await getGithubToken();

const github = new Octokit({
  auth: token,
});

const results = [];

const iterator = github.paginate.iterator(
  "GET /notifications?query=reason%3Areview-requested"
);

for await (const { data: notifications } of iterator) {
  for (const notification of notifications) {
    if (notification.subject.type !== "PullRequest") {
      continue;
    }

    const url = new URL(notification.subject.url);
    const { data: pr } = await github.request(`GET ${url.pathname}`);
    const isReviewer = pr.requested_reviewers.find((r) => r.login === "mckn");
    const isTeamReviewer = pr.requested_teams.find(
      (r) =>
        r.slug === "plugins-platform-frontend" || r.slug === "plugins-platform"
    );

    if (pr.state !== "closed" && (isReviewer || isTeamReviewer)) {
      continue;
    }

    await github.request("DELETE /notifications/threads/{thread_id}", {
      thread_id: notification.id,
    });

    results.push(pr.html_url);
  }
}

console.log(results.join("\n"));
console.log(`${results.length} PR notifications cleared! 🚀`);

async function getGithubToken() {
  const token = await exec("gh auth token").catch(() => ({}));

  if (token.stdout) {
    return { succeeded: true, token: token.stdout };
  }

  const help = await exec("gh").catch((error) => ({
    stderr: error,
  }));

  return {
    error:
      (help.stderr && `Could not run \`gh\`: ${help.stderr}`) ||
      token.stderr ||
      undefined,
    succeeded: false,
  };
}

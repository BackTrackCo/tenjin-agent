# Discord notifications

`workflows/discord-notify.yml` posts the repository name, number, title, and link
when a pull request or issue is first opened. PRs and issues go to separate text
channels. It includes draft PRs and ignores edits, comments, pushes, reopens, and
closes. Delivery goes directly from GitHub Actions to Discord.

## Setup

1. In Discord, create two text channels, such as `#github-prs` and
   `#github-issues`. Under **Server Settings → Integrations → Webhooks**, create
   one webhook for each channel. Copy the original URLs without appending
   `/github`. Keep webhook URLs secret; anyone holding one can post to its
   channel. Restrict channel membership when sending private repository details.
2. In the GitHub organization's **Settings → Secrets and variables → Actions**,
   create `DISCORD_PR_WEBHOOK_URL` with the PR channel's URL and
   `DISCORD_ISSUE_WEBHOOK_URL` with the issue channel's URL. Grant both secrets
   access to `tenjin` and `tenjin-agent`, including the public repository.
3. If the organization plan does not make organization secrets available to
   private repositories, create both secrets in each repository's
   **Settings → Secrets and variables → Actions** instead.
4. An administrator should check **Settings → Actions → Policies**, including
   inherited policies, for public repositories. This metadata-only workflow
   needs `pull_request_target` allowed for `.github/workflows/discord-notify.yml`.
   GitHub's default policy is in evaluate mode and starts blocking that event
   in affected public repositories on November 2, 2026; see
   [GitHub's policy guidance](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target#default-policy-for-pull_request_target).
   Scope any allowance to this workflow rather than enabling it for every
   workflow. This does not require permitting untrusted PR code to run.
5. Merge the PR into each repository's default branch after review and green CI.
   Other organization repositories need the same workflow and access to both
   secrets; an organization secret alone does not enable notifications there.
6. Disable any direct GitHub-to-Discord webhook configured for these same
   notifications so it does not also forward other activity.
7. Open a new PR and issue after merging. Check **Actions → Discord creation
   notifications** and verify each message reaches its intended channel. Missing
   destination secrets and delivery errors fail the job, with no fallback to the
   other channel. Each teammate sets Discord notification preferences separately.

`pull_request_target` lets the default-branch workflow notify for fork PRs.
It reads only GitHub's event JSON and never checks out or runs PR code. It has
no GitHub token permissions, and titles cannot trigger Discord mentions.

To stop notifications, disable this workflow in the repository's Actions tab.

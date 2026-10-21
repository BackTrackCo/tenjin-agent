# Discord notifications

`workflows/discord-notify.yml` posts the repository name, number, title, and link
when a pull request or issue is first opened. It includes draft PRs and ignores
edits, comments, pushes, reopens, and closes.

## Setup

1. In Discord, create a webhook for the team's notification text channel under
   **Server Settings → Integrations → Webhooks**. Copy its original URL, without
   appending `/github`.
2. In the GitHub organization's **Settings → Secrets and variables → Actions**,
   create an organization secret named `DISCORD_WEBHOOK_URL` with that URL.
   Grant repository access to both `tenjin` and `tenjin-agent`, including the
   public repository. Both workflows use the same secret and destination.
3. If the organization plan does not make organization secrets available to
   private repositories, create the same secret in each repository's
   **Settings → Secrets and variables → Actions** instead.
4. Merge the workflow into each repository's default branch. An organization
   secret shares the URL; each repository still needs its workflow.
5. Disable any direct GitHub-to-Discord webhook configured for these same
   notifications so it does not also forward other activity.
6. Open a new PR and issue after merging. Check **Actions → Discord creation
   notifications** and the Discord channel. Missing secrets and delivery errors
   fail the notification job. Discord channel notification preferences are set
   separately by each teammate.

`pull_request_target` lets the default-branch workflow notify for fork PRs.
It reads only GitHub's event JSON and never checks out or runs PR code. It has
no GitHub token permissions, and titles cannot trigger Discord mentions.

To stop notifications, disable this workflow in the repository's Actions tab.

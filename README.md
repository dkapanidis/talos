# Talos

A lightweight agent that listens for Linear issue assignments and uses Claude Code to autonomously work on them. Assign an issue to your bot user in Linear, and the agent clones the repo, creates a branch, implements the changes, pushes a PR, and posts results back to Linear.

## Architecture

```
Linear Issue (assigned to bot)
  → Webhook → Fastify server
  → Clone repo / create git worktree
  → Spawn Claude Code with issue context
  → Claude Code works (reads code, edits, tests, commits, pushes, creates PR)
  → Post summary back to Linear as comment
```

Prompts are composed in three layers:

1. **Global system prompt** — applied to all repos (e.g., "always run tests before committing")
2. **Per-repo system prompt** — repo-specific conventions (e.g., "use conventional commits")
3. **Issue context** — title, description, comments, branch name from Linear

## Prerequisites

- Node.js 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed globally (`npm install -g @anthropic-ai/claude-code`)
- A Linear API key
- A GitHub token (for private repos and PR creation)
- An `ANTHROPIC_API_KEY` environment variable for Claude Code

## Setup

### 1. Install dependencies

```bash
bun install
bun run build
```

### 2. Create a bot user in Linear

Create a dedicated Linear account that the agent will act as. Note its **User ID** (Linear Settings > API > User ID).

### 3. Configure

```bash
cp config.example.yaml config.yaml
```

Edit `config.yaml`:

```yaml
linearApiKey: "lin_api_..."
linearWebhookSecret: "your-webhook-secret"
githubToken: "ghp_..."
botUserId: "your-bot-user-id"

workDir: "./work"

systemPrompt: |
  You are an autonomous coding agent assigned a Linear issue.
  - Read the issue carefully.
  - Explore the codebase.
  - Implement the changes.
  - Run tests if they exist.
  - Commit, push, and create a PR.

repos:
  owner/repo-name:
    url: "https://github.com/owner/repo-name"
    systemPrompt: |
      - Always push on branches matching the Linear git branch naming convention.
      - Run `npm test` before committing.
      - Use conventional commits (feat:, fix:, chore:).
    teamIds:
      - "TEAM-1"
```

The `repos` block is entirely optional — it only carries per-repo system prompts
and optional routing hints. See [Repository routing](#repository-routing) for how
an issue finds its repo without it.

### 4. Set up the Linear webhook

1. Go to **Linear Settings > API > Webhooks**
2. Create a webhook pointing to `https://your-server:3000/webhook`
3. Select **Issue** events (create, update)
4. Copy the signing secret into `config.yaml` as `linearWebhookSecret`

Every request to `/webhook` must carry a `linear-signature` header matching an
HMAC-SHA256 of the raw request body under that secret; unsigned and
wrongly-signed requests are rejected with a 401. The endpoint starts agent runs
with real credentials, so leaving `linearWebhookSecret` empty — which disables
verification — is only safe when the port is not reachable from the internet.

### OAuth token lifetime

Linear's OAuth access tokens expire after **24 hours**. The agent refreshes
automatically when a call comes back 401, but Linear rotates the refresh token
on every exchange and invalidates the old one. Set `tokenStore` to `file` or
`kubernetes` for any long-running deployment: without it the refreshed pair
lives only in memory, and the next restart falls back to the now-invalid tokens
in `config.yaml`, which can only be fixed by re-running the OAuth install flow.

### 5. Run

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
bun run dev
```

Or pass a custom config path:

```bash
node dist/index.js /path/to/config.yaml
```

## GitHub integration

The agent also responds on GitHub. It runs as a **GitHub App**, which is not a
user account and so consumes no seat on a paid plan.

Two triggers:

- **`/talos <instruction>` at the start of a line** in an issue or PR comment.
  Slash commands live outside the account namespace, so this is the safe form.
- **`@<mentionName>` in a comment.** Matched as literal text in the webhook
  payload — GitHub never has to resolve the name for the trigger to fire. Pick a
  name **no GitHub account holds**: if one does, GitHub resolves the mention and
  notifies that person on every message. (`@talos`, `@talos-agent`, `@talos-bot`
  are all real accounts.)
- **Adding the `talos` label to an issue.** GitHub Apps cannot be assignees, so
  a label stands in for assignment.

The agent's own comments are ignored, so posting a result cannot re-trigger it.

### Live progress

GitHub has no streaming surface for issues, so progress is shown the way
GitHub's own bots do it — **one comment, rewritten as the run proceeds**:

1. The triggering comment gets a 👀 reaction the moment the webhook lands.
2. A status comment is posted immediately, naming the branch.
3. That same comment is edited as the agent works, showing the latest status
   and a collapsible list of the most recent steps.
4. When the run ends, the comment is replaced by the final result.

Edits are throttled to one per 10 seconds and coalesced, so a fast-moving run
produces a steadily updating comment rather than a burst of writes that would
trip GitHub's secondary rate limits.

### Creating the App

1. **Settings > Developer settings > GitHub Apps > New GitHub App**, on the
   account or organisation that should own it. App names share the account
   namespace, so a name held by any user or org is unavailable.
2. **Webhook URL**: `https://your-server/github/webhook`, and set a **webhook
   secret** — deliveries without a valid signature are rejected.
3. **Repository permissions**: Contents `Read & write` (clone and push),
   Issues `Read & write` (read the thread, post results), Pull requests
   `Read & write` (open PRs), Metadata `Read-only` (mandatory).
4. **Subscribe to events**: Issue comment, Issues, Pull request review comment.
5. **Where can this App be installed**: choose *Any account* if it needs to
   serve repositories owned by more than one account or organisation.
6. Generate a **private key** and note the **App ID**.
7. **Install** the App, choosing *All repositories* so new repos are covered
   without another visit.

Then set:

```yaml
github:
  appId: "123456"
  privateKey: |
    -----BEGIN RSA PRIVATE KEY-----
    ...
  webhookSecret: "..."
  commandName: "talos"          # /talos <instruction>
  mentionName: "harbur-talos"   # must not be a real GitHub account
  triggerLabel: "talos"
```

`githubToken` stays as a fallback for repositories where the App is not
installed; with the App configured, clone/push and `gh` inside the agent use a
short-lived installation token instead.

## Repository routing

Nothing has to be configured for the agent to find the right repo. For each
issue it tries, in order:

1. **Explicit config** — a `repos` entry whose `teamIds`/`labels` single one out.
2. **Links on the issue** — Linear's GitHub integration attaches branch and pull
   request URLs, which name the repo outright. Descriptions and comments are
   scanned too.
3. **What you chose last time** — answers are remembered per team + label
   combination, so the same kind of issue routes itself from then on.
4. **Asking** — an elicitation listing every non-archived repo the GitHub token
   can see. The answer is remembered, so each team + label combination is only
   ever asked about once.

Reply to the question with either the full slug (`harbur/ray-app`) or just the
repo name (`ray-app`). Remembered answers live in the `tokenStore`, so set one
up if you want them to survive a restart.

## How It Works

1. You assign a Linear issue to your bot user
2. Linear sends a webhook to your server
3. The server fetches the full issue context (title, description, comments, labels, branch name) from the Linear API
4. It clones the matching repo (if not already cloned) and creates an isolated git worktree on the Linear-generated branch
5. Claude Code is spawned with `--print` mode in the worktree, receiving the composed prompt
6. When Claude Code finishes, the result is posted back as a comment on the Linear issue
7. The worktree is cleaned up

Each issue runs in its own worktree, so multiple issues can be worked on in parallel without conflicts.

### The work directory

`workDir` holds two things:

```
work/repos/<owner>-<repo>      one cached clone per repository
work/worktrees/<owner>-<repo>-<branch>   one worktree per issue
```

The clones are a **cache** and are meant to outlive the process — in Kubernetes
they sit on a PersistentVolume mounted at `/app/work`, so a cold clone is paid
once rather than on every task. Everything that follows from that:

- **Every run fetches before it works.** A new branch is cut from
  `origin/<default>` and an existing one is reset to its own remote branch, so a
  cached clone never bases work on a stale commit.
- **The remote URL is rewritten on every run.** Git stores the credential in the
  remote URL at clone time, and a GitHub App installation token expires after an
  hour, so a cache older than that would otherwise fetch with a dead token.
- **Worktrees are disposable.** One is removed and re-created rather than
  reused: committed work lives on the branch, and uncommitted leftovers from a
  crashed run must not leak into the next one. Cleanup runs on the failure path
  too, or a failed run would leak a worktree onto the volume permanently.

The cache is safe to delete at any point; the next run re-clones.

## Configuration Reference

| Field | Env Var | Description |
|---|---|---|
| `linearApiKey` | `LINEAR_API_KEY` | Linear API key |
| `linearWebhookSecret` | `LINEAR_WEBHOOK_SECRET` | Webhook signing secret |
| `githubToken` | `GH_TOKEN` | GitHub token for cloning and pushing |
| `botUserId` | — | Linear user ID of the bot account |
| `workDir` | — | Directory for clones and worktrees (default: `./work`) |
| `tokenStore.kind` | `TOKEN_STORE_KIND` | Where refreshed OAuth tokens persist: `none`, `file`, or `kubernetes` |
| `tokenStore.path` | — | JSON file path when kind is `file` |
| `tokenStore.secretName` | — | Secret name when kind is `kubernetes` (default: `talos-oauth-tokens`) |
| `tokenStore.namespace` | `POD_NAMESPACE` | Namespace when kind is `kubernetes` (default: the pod's own) |
| `systemPrompt` | — | Global system prompt for Claude Code |
| `repos.<slug>.url` | — | Git clone URL |
| `repos.<slug>.systemPrompt` | — | Repo-specific system prompt |
| `repos.<slug>.teamIds` | — | Optional: Linear team keys that map to this repo |
| `repos.<slug>.labels` | — | Optional: issue labels that map to this repo |
| `github.appId` | `GITHUB_APP_ID` | GitHub App ID |
| `github.privateKey` | `GITHUB_APP_PRIVATE_KEY` | GitHub App PEM private key |
| `github.webhookSecret` | `GITHUB_WEBHOOK_SECRET` | Secret for `X-Hub-Signature-256` verification |
| `github.mentionName` | — | Literal `@name` that triggers a run (default: `botMentionName`) |
| `github.triggerLabel` | — | Label that triggers a run (default: `talos`) |

## Local Development

For local development, use a tunnel like [ngrok](https://ngrok.com/) or [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) to expose your local server to Linear webhooks:

```bash
ngrok http 3000
# Use the ngrok URL as your webhook endpoint in Linear
```

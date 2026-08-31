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

The `teamIds` field maps a Linear team key to a repo. If you only have one repo configured, it's used as the default for all issues.

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

## How It Works

1. You assign a Linear issue to your bot user
2. Linear sends a webhook to your server
3. The server fetches the full issue context (title, description, comments, labels, branch name) from the Linear API
4. It clones the matching repo (if not already cloned) and creates an isolated git worktree on the Linear-generated branch
5. Claude Code is spawned with `--print` mode in the worktree, receiving the composed prompt
6. When Claude Code finishes, the result is posted back as a comment on the Linear issue
7. The worktree is cleaned up

Each issue runs in its own worktree, so multiple issues can be worked on in parallel without conflicts.

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
| `repos.<slug>.teamIds` | — | Linear team keys that map to this repo |

## Local Development

For local development, use a tunnel like [ngrok](https://ngrok.com/) or [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) to expose your local server to Linear webhooks:

```bash
ngrok http 3000
# Use the ngrok URL as your webhook endpoint in Linear
```

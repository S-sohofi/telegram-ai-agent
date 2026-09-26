# Telegram Agent Bot on Cloudflare Workers

A modular Telegram assistant that runs on Cloudflare Workers. It supports
Gemini with native tools, Cloudflare Workers AI fallbacks, persistent chat
history, voice transcription, media understanding, and web-backed fact checks.

The repository is the source of truth: change modules under `src/`, run the
tests, and deploy with Wrangler. There is no dashboard copy/paste workflow or
monolithic Worker file to maintain.

## Features

- Private chats, group mentions, and replies
- Immediate and continuously refreshed Telegram typing indicators
- Gemini text generation with automatic model fallbacks
- Native Gemini Google Search, URL Context, and Code Execution tools
- Cloudflare Workers AI as the final text fallback
- Clickable source titles without visible raw URLs
- KV-backed conversation history and relevance-based context selection
- Voice transcription with Cloudflare Whisper
- Photo and Telegram video/GIF thumbnail analysis
- `/check` fact checking with Tavily evidence
- Queue-based webhook processing with 24-hour update deduplication
- `/health` and `/setWebhook` operational endpoints

## Architecture

```text
src/
├── index.js                    HTTP and Queue entry points
├── config.js                   Defaults, limits, prompts, and messages
├── handlers/
│   └── update.js               Telegram update routing
├── features/
│   ├── fact-check.js           Tavily search and sourced verdicts
│   └── media.js                Photo and thumbnail preparation
├── services/
│   ├── ai.js                   Provider selection and AI fallbacks
│   ├── gemini.js               Gemini REST client and native tools
│   ├── chat-history.js         KV-backed conversation context
│   └── telegram.js             Telegram API and webhook client
└── utils/
    ├── ai-response.js          AI response normalization
    ├── common.js               Shared helpers
    ├── media.js                Media size and encoding helpers
    └── telegram-message.js     Mentions, replies, and commands
```

## Prerequisites

- [Node.js 20 or newer](https://nodejs.org/en/download)
- A [Cloudflare account](https://dash.cloudflare.com/sign-up)
- A Telegram bot created with [@BotFather](https://t.me/BotFather)

Wrangler is installed as a project dependency by `npm install`. Cloudflare
authentication uses browser OAuth, so a Cloudflare API token is not required
for normal setup and deployment.

## Credentials and API keys

| Credential | Required? | Where to get it |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Yes | Create a bot with [@BotFather](https://t.me/BotFather). Telegram bot tokens are free. |
| `GEMINI_API_KEY` | Recommended | Create a key in [Google AI Studio](https://aistudio.google.com/apikey). Gemini offers a free API tier, subject to Google's current model, regional, and rate limits. See [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing). |
| `TAVILY_API_KEY` | Only for `/check` | Create a key at the [Tavily dashboard](https://app.tavily.com/home). Tavily provides a free credit tier; see its [API credit documentation](https://docs.tavily.com/documentation/api-credits). |
| `TELEGRAM_WEBHOOK_SECRET` | Strongly recommended | Generate this locally; it is not supplied by a vendor. Instructions are below. |

Gemini is the primary text provider. If its key is omitted, invalid, rate
limited, or unavailable, the application falls back to the configured
Cloudflare Workers AI models. Workers AI uses the `AI` binding and does not
require a separate API key. Review its [pricing and free allocation](https://developers.cloudflare.com/workers-ai/platform/pricing/).

Never place real credential values in source files, `README.md`,
`wrangler.jsonc`, or `.dev.vars.example`.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Authenticate with Cloudflare

```bash
npx wrangler login
```

Wrangler opens Cloudflare OAuth in a browser. Confirm the account that should
own the Worker and its resources.

### 3. Create your local Wrangler configuration

The real `wrangler.jsonc` is intentionally ignored because it contains
deployment-specific resource identifiers.

PowerShell:

```powershell
Copy-Item wrangler.example.jsonc wrangler.jsonc
```

Bash:

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

Change the generic Worker `name` in `wrangler.jsonc` if desired.

### 4. Create Cloudflare resources

Create the KV namespace used for conversation history and update
deduplication:

```bash
npx wrangler kv namespace create CHAT_HISTORY
```

Copy the returned namespace ID into the `CHAT_HISTORY` entry in
`wrangler.jsonc`, replacing `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

Create the Queue used for reliable background processing:

```bash
npx wrangler queues create telegram-agent-updates
```

The example configuration already declares:

- Workers AI binding: `AI`
- KV binding: `CHAT_HISTORY`
- Queue producer binding: `TELEGRAM_UPDATES`
- Queue consumer: `telegram-agent-updates`

### 5. Add production secrets

Wrangler prompts for each value without placing it in the repository:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put TAVILY_API_KEY
```

Skip `TAVILY_API_KEY` if `/check` is not needed. Skip `GEMINI_API_KEY` only if
Cloudflare Workers AI should handle all text requests.

Generate and upload a random webhook secret with Node.js:

```bash
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))" | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

If a secret changes later, run the corresponding `wrangler secret put`
command again. Secret changes do not require committing any file.

### 6. Test and deploy

```bash
npm test
npm run check
npm run deploy
```

Wrangler prints the deployed URL, for example:

```text
https://<worker-name>.<workers-subdomain>.workers.dev
```

### 7. Register the Telegram webhook

Replace `<YOUR_WORKER_URL>` with the URL printed by Wrangler.

PowerShell:

```powershell
$workerUrl = "https://<worker-name>.<workers-subdomain>.workers.dev"
Invoke-RestMethod "$workerUrl/setWebhook"
Invoke-RestMethod "$workerUrl/health"
```

Bash:

```bash
WORKER_URL="https://<worker-name>.<workers-subdomain>.workers.dev"
curl "$WORKER_URL/setWebhook"
curl "$WORKER_URL/health"
```

`/setWebhook` returns Telegram's webhook state, pending update count, and most
recent delivery error when one exists. Re-run it after changing
`TELEGRAM_WEBHOOK_SECRET` or moving the bot to another Worker URL.

## Local development

Copy the placeholder file and add development-only values:

PowerShell:

```powershell
Copy-Item .dev.vars.example .dev.vars
npm run dev
```

Bash:

```bash
cp .dev.vars.example .dev.vars
npm run dev
```

`.dev.vars` and `wrangler.jsonc` are ignored by Git. Do not remove those
entries from `.gitignore`.

## Provider and tool configuration

The default text-provider order is:

1. `gemini-2.5-flash`
2. `gemini-3.8-flash`
3. `gemini-3.5-flash-lite`
4. Cloudflare Workers AI

Useful optional Worker variables:

| Variable | Purpose |
| --- | --- |
| `GEMINI_MODELS` | Comma-separated Gemini fallback order |
| `GEMINI_ENABLED=false` | Disable Gemini completely |
| `GEMINI_GOOGLE_SEARCH=false` | Disable native Google Search |
| `GEMINI_URL_CONTEXT=false` | Disable URL Context |
| `GEMINI_CODE_EXECUTION=false` | Disable Code Execution |
| `GEMINI_TIMEOUT_MS` | Per-model Gemini timeout |
| `TEXT_MODEL` | Primary Cloudflare Workers AI fallback model |
| `TEXT_FALLBACK_MODELS` | Comma-separated Workers AI fallbacks |
| `FACT_CHECK_MAX_QUERIES` | Maximum Tavily searches for `/check` |
| `FACT_CHECK_RESULTS_PER_QUERY` | Tavily results collected per query |
| `CONTEXT_MAX_MESSAGES` | Maximum history messages in AI context |
| `CONTEXT_MAX_BYTES` | Maximum serialized context size |

Gemini may choose Google Search for current information, URL Context when the
message contains a URL, and Code Execution for calculations or code-oriented
requests. `/check` intentionally disables Gemini tools and uses only the
evidence returned by Tavily.

## Telegram group setup

In groups, the bot responds when mentioned or when a user replies to one of
its messages. If full group-history collection is desired, review BotFather's
[privacy mode](https://core.telegram.org/bots/features#privacy-mode). Keep
privacy mode enabled when the bot should only receive commands, mentions, and
replies.

## Useful commands

```bash
npm test                         # Run unit and behavior tests
npm run check                    # Tests plus Wrangler dry-run build
npm run dev                      # Start local Wrangler development
npm run deploy                   # Deploy the configured Worker
npx wrangler tail <worker-name>  # Stream live Worker and Queue logs
```

## Troubleshooting

- **Webhook requests return `403`:** run `/setWebhook` again after confirming
  `TELEGRAM_WEBHOOK_SECRET` exists in Cloudflare.
- **The bot acknowledges messages but does not reply:** inspect Queue events
  with `wrangler tail` and verify the Queue has one producer and one consumer.
- **Gemini returns `429`:** the bot automatically tries the next Gemini model,
  then Cloudflare Workers AI.
- **`/check` is unavailable:** configure `TAVILY_API_KEY`.
- **No chat history:** verify the `CHAT_HISTORY` KV namespace ID and binding.

## Optional Cloudflare MCP integration

Cloudflare's official API MCP server can manage account resources through
OAuth, without a Cloudflare API token:

```bash
codex mcp add cloudflare-api --url https://mcp.cloudflare.com/mcp
codex mcp login cloudflare-api
```

References:

- [Cloudflare API MCP server](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/)
- [Codex MCP configuration](https://developers.openai.com/codex/mcp/)

## Security checklist

- Store production credentials only with `wrangler secret put`.
- Keep local credentials only in `.dev.vars`, which is ignored by Git.
- Keep deployment-specific IDs in the ignored `wrangler.jsonc`.
- Commit only placeholder values in examples and documentation.
- Never paste tokens into issues, logs, screenshots, commits, or chat messages.
- Rotate a credential immediately if it is ever exposed.
- Deleting a secret from the latest files does not remove it from Git history;
  rotate it and follow a reviewed history-rewrite procedure when necessary.

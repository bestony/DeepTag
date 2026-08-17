# DeepTag

Deepseek implement of Claude Tag

## Getting started

```sh
pnpm install
cp .env.example .env   # optional; every variable has a default
pnpm dev
```

`pnpm dev` runs `node --watch src/index.ts`. Node.js strips the TypeScript types
natively, so there is no separate build step or transpiler in the dev loop; the
`erasableSyntaxOnly` compiler option keeps the sources within what the runtime
can strip.

| Command          | Description                                    |
| ---------------- | ---------------------------------------------- |
| `pnpm dev`       | Start the server with reload on file changes   |
| `pnpm typecheck` | Type check the project (`tsc --noEmit`)        |
| `pnpm build`     | Compile to `dist/`                             |
| `pnpm start`     | Run the compiled server from `dist/`           |

### Endpoints

| Method | Path      | Description                                                          |
| ------ | --------- | -------------------------------------------------------------------- |
| `GET`  | `/`       | Returns `Hono!`                                                      |
| `GET`  | `/health` | Health check: status, service, uptime, timestamp, Lark and agent state |

```sh
curl http://127.0.0.1:3000/health
# {"status":"ok","service":"deeptag","uptime":12.34,"timestamp":"...",
#  "lark":{"enabled":true,"state":"connected","reconnectAttempts":0},
#  "agent":{"enabled":true,"model":"deepseek-v4-flash","sessions":0,
#           "instructionFiles":["AGENTS.md"],"workspaceReady":true}}
```

`lark.state` is reported but deliberately kept out of `status`: a degraded bot
connection does not mean the process should be restarted or pulled from a load
balancer, and the SDK reconnects on its own.

## Lark / Feishu bot

`pnpm dev` starts the Hono server and, when credentials are present, opens a
Lark WebSocket connection in the same process. Long-connection mode means no
public callback URL is needed, so it works from a laptop behind NAT.

Set `LARK_APP_ID` and `LARK_APP_SECRET` (see [`.env.example`](./.env.example))
and configure the app in the developer console with:

- scope `im:message`
- event subscription `im.message.receive_v1`
- event delivery mode **Long Connection** (WebSocket)

Without credentials the HTTP server still starts and only the bot is disabled,
so a fresh clone runs without holding any secrets.

Each text message is handed to the agent (below) and the answer comes back as an
interactive card. Non-text messages are logged and ignored. Handler code lives
in `src/lark/events.ts`; connection lifecycle in `src/lark/client.ts`.

The event handler acknowledges immediately and answers out of band, because the
gateway redelivers events whose handler does not return promptly and a model
turn can take tens of seconds.

Redelivered events are dropped by `event_id` (falling back to `message_id`)
through the bounded, expiring set in `src/dedupe.ts` — otherwise a redelivery
would cost the user a duplicate reply and cost the account a duplicate model
call. Keys are claimed synchronously, before any `await`, so two deliveries
racing each other cannot both pass. The window is one hour and 10,000 keys.

Note that `pnpm dev` reconnects on every file change, since `node --watch`
restarts the process.

## Agent

Messages are answered by [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core)
running on DeepSeek's official API through
[`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai).
Set `DEEPSEEK_API_KEY` to enable it; `AGENT_MODEL` defaults to
`deepseek-v4-flash`.

| Module                      | Responsibility                                          |
| --------------------------- | ------------------------------------------------------- |
| `src/agent/model.ts`        | Registers the DeepSeek provider and resolves the model  |
| `src/agent/instructions.ts` | Builds the system prompt from `DATA_DIR`                |
| `src/agent/workspace.ts`    | Per-chat workspaces and the tools bound to them         |
| `src/agent/runner.ts`       | Per-chat sessions, serialization, timeouts, pruning     |
| `src/agent/service.ts`      | The app-wide instance wired from configuration          |

pi-ai ships catalogs for many providers, but only DeepSeek is registered: a
smaller catalog means a smaller failure surface and no unrelated provider SDKs
loaded at runtime.

**Conversation state.** Each Lark `chat_id` gets its own `Agent`, which owns
that chat's transcript, so follow-up messages keep context. Three bounds keep
that from growing without limit:

- at most 200 chats are tracked, evicting the least recently used;
- a chat idle for an hour starts fresh;
- at most 60 transcript messages are resent per turn, since every turn resends
  the history and that is what drives cost.

**Serialization.** Runs for one chat are chained, because a single stateful
`Agent` driven by two concurrent messages would interleave their transcripts.
Different chats still run concurrently.

**Tools.** Each session gets `read`, `write`, `edit` and `bash`, bound to that
chat's workspace — see below.

### Workspace

Every session runs in a workspace: a directory the agent works in, and the file
and shell tools rooted there. `WORKSPACE_DIR` (default `./workspace`) is the
root, and each chat gets its own directory beneath it:

```
workspace/                    # WORKSPACE_DIR
├── oc_9a3f1c...-4e91b0d2/    # one chat
│   └── report.md
└── oc_71bd88...-c07af5e3/    # another
    └── notes.txt
```

One workspace per chat rather than one shared by all: a shared directory lets
one conversation read and overwrite another's files, which for a bot sitting in
a company's group chats is a confidentiality problem, not just an untidy one.

The directory is created when the session starts — before the model is told
about it, let alone able to call a tool — and the absolute path is named in the
system prompt so the model knows where it is. Relative paths in `read`, `write`,
`edit` and `bash` resolve against it.

Directory names are `<slug>-<digest>`: the chat id with everything outside
`[A-Za-z0-9_-]` replaced, truncated, plus 8 hex characters of its SHA-256. The
id arrives from the transport and is never used as a path segment directly —
`../../etc` would walk out of the root — while the digest keeps two ids that
slug alike from colliding and the readable prefix keeps `ls` useful.

**Directories outlive sessions.** A chat evicted from the session registry, or
idle past the TTL, keeps its files; only the transcript is dropped. Nothing
deletes a workspace, so growth on disk is yours to manage.

**Shell access is not sandboxed.** `bash` runs commands as the server process
with the workspace as its working directory, and `cd` or an absolute path leaves
it at will. Run DeepTag in a container if that matters to you. The shell
environment is *not* inherited from the server process: it is built from an
allowlist in `src/config.ts` (`PATH`, `HOME`, `LANG`, …), because the process
environment holds `DEEPSEEK_API_KEY` and the Lark credentials and `env` would
otherwise print them into the chat. Adding a name to that list deliberately
exposes that variable to the model.

Keep `WORKSPACE_DIR` outside `DATA_DIR`. The agent can write and run commands in
its workspace, so a nested layout lets it rewrite the `AGENTS.md` it was given;
overlapping paths are reported as a `configuration problem` at startup.

### System prompt and the data directory

`DATA_DIR` (default `./data`) holds the operator-editable state that shapes the
agent. When the agent starts, two files are read from it and appended to the
base prompt — the one from `AGENT_SYSTEM_PROMPT`, or the built-in default:

| File        | Tag in the prompt     | Purpose                                    |
| ----------- | --------------------- | ------------------------------------------ |
| `AGENTS.md` | `<agent_instructions>` | Durable, operator-authored instructions    |
| `MEMORY.md` | `<agent_memory>`      | Facts carried across conversations         |

```
data/
├── AGENTS.md   # optional
└── MEMORY.md   # optional
```

Both files are optional, and missing and empty are treated identically: such a
file contributes **nothing** — no header, no placeholder — so with neither
present the agent sees exactly the base prompt. That is the state of a fresh
clone, and the directory itself need not exist.

Contents are wrapped in XML-style tags rather than markdown headings, because
the files are markdown themselves and may open with `# ...`, which would blur
the boundary between prompt and content.

Files are read once, while the agent is built at startup, and every chat session
shares the result — so edits take effect on the next restart, not mid-run.
`GET /health` reports which files made it in:

```sh
curl -s http://127.0.0.1:3000/health | jq .agent
# {"enabled":true,"model":"deepseek-v4-flash","sessions":0,
#  "instructionFiles":["AGENTS.md"]}
```

An unreadable file (bad permissions, a directory where a file was expected) is
logged as a warning and skipped: a broken data directory should not stop the bot
from answering. Because `MEMORY.md` can accumulate whatever a conversation
mentions, treat the data directory as private and keep it out of version control
if you point it at anything a deployment writes to.

### Configuration

On startup the server loads a `.env` file from the project root via `dotenv`.
See [`.env.example`](./.env.example) for the full list. Variables already set in
the real environment take precedence over the file, so a deployment's
configuration is never shadowed by a stray `.env`; a missing `.env` is fine and
every variable is optional.

| Variable    | Default                        | Description                                          |
| ----------- | ------------------------------ | ---------------------------------------------------- |
| `PORT`      | `3000`                         | Listening port                                       |
| `HOST`      | `127.0.0.1`                    | Bind address; set `0.0.0.0` in containers            |
| `LOG_LEVEL` | `debug` (`info` in production) | One of `debug`, `info`, `warn`, `error`, `silent`    |
| `NODE_ENV`  | `development`                  | `production` narrows the default log level to `info` |
| `DATA_DIR`  | `./data`                       | Holds `AGENTS.md` and `MEMORY.md`; need not exist    |
| `WORKSPACE_DIR` | `./workspace`              | Root of the per-chat workspaces; created at startup  |
| `LARK_APP_ID` | –                            | Lark app id; must be set together with the secret    |
| `LARK_APP_SECRET` | –                        | Lark app secret; unset disables the bot              |
| `LARK_DOMAIN` | `feishu`                     | `feishu` (mainland China) or `lark` (international)  |
| `DEEPSEEK_API_KEY` | –                       | Enables the agent; unset makes it answer "not configured" |
| `AGENT_MODEL` | `deepseek-v4-flash`          | `deepseek-v4-flash` or `deepseek-v4-pro`             |
| `AGENT_SYSTEM_PROMPT` | built-in             | System prompt handed to the agent                    |
| `AGENT_TIMEOUT_MS` | `120000`                | Backstop before an in-flight turn is aborted         |

Invalid values are reported as a `configuration problem` warning and fall back
to the default rather than aborting startup. All parsing lives in
`src/config.ts`, which is the only module that reads `process.env`: it loads
`.env` during its own evaluation, so importing it is what guarantees the file is
read before any value is used.

Logs are emitted as one JSON object per line.

## Development

Git hooks are managed by [lefthook](https://lefthook.dev) and installed by
`pnpm install`. The `pre-commit` hook runs a project-wide `tsc --noEmit`
whenever TypeScript sources change. Set `LEFTHOOK=0` to bypass it for a single
command.

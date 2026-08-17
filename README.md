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
| `src/agent/memory.ts`       | Memory about people and chats, and who may recall it    |
| `src/agent/memory-tools.ts` | The `remember` and `recall` tools                       |
| `src/agent/distill.ts`      | Post-turn extraction of what is worth remembering       |
| `src/agent/transcript.ts`   | Persisted transcripts, so a chat resumes after restart  |
| `src/agent/runner.ts`       | Per-chat sessions, serialization, timeouts, pruning     |
| `src/agent/service.ts`      | The app-wide instance wired from configuration          |

pi-ai ships catalogs for many providers, but only DeepSeek is registered: a
smaller catalog means a smaller failure surface and no unrelated provider SDKs
loaded at runtime.

**Conversation state.** Each Lark `chat_id` gets its own `Agent`, which owns
that chat's transcript, so follow-up messages keep context. The in-memory
registry is a cache over the persisted transcript (below), and is bounded:

- at most 200 chats are held in memory, evicting the least recently used;
- a chat idle for an hour is dropped from memory;
- at most 60 transcript messages are resent per turn, since every turn resends
  the history and that is what drives cost.

The first two bound memory, not the conversation: a dropped chat is restored
from disk on its next message. The third bounds what is *sent*, not what is
*stored*.

**Serialization.** Runs for one chat are chained, because a single stateful
`Agent` driven by two concurrent messages would interleave their transcripts.
Different chats still run concurrently.

**Tools.** Each session gets `read`, `write`, `edit` and `bash`, bound to that
chat's workspace, plus `remember` and `recall` — see below.

### Memory about people and chats

`DATA_DIR/MEMORY.md` is one file you write by hand, shared by every
conversation. This is the other half: memory the agent accumulates itself,
filed under *who* or *where* it is about, so that "what did this person decide"
and "what does this team have going on" are separate questions with separate
answers. It lives under `MEMORY_DIR` (default `./memory`), one JSONL file per
subject:

```
memory/                          # MEMORY_DIR
├── users/ou_9a3f1c...-4e91b0d2.jsonl    # keyed by Lark open_id
└── groups/oc_71bd88...-c07af5e3.jsonl   # keyed by chat_id
```

A `user` subject follows a person between chats; a `group` subject is always
the chat being replied in — the model cannot name another chat, which removes
cross-group leakage as a possibility rather than as a rule to enforce.

**Writing** happens two ways, because their failure modes are opposite. The
`remember` tool covers what the agent notices it should keep; a post-turn
distiller — a second, cheap model call on the finished exchange — covers what
it did not. The tool forgets to fire, the distiller over-collects, so its prompt
is written to prefer recording nothing and the store drops duplicates
(whitespace- and case-insensitive). Distillation runs detached, after the reply
is on its way, and only for turns that actually produced an answer.

**Reading** also happens two ways. The current speaker's memory and this chat's
memory are rendered into the system prompt on every turn, capped at 12 entries
each, so the common case needs no tool call. `recall` is there for older entries
and for topic searches. Memory goes in the *system* prompt, not the user
message: it is instruction rather than conversation, and the system prompt is
never written to the transcript, so today's snapshot does not sit in the history
forever being resent long after it went stale.

In a group the speaker changes from message to message while the session does
not, so identity belongs to the request (`src/agent/request.ts`). The prompt is
recomposed and the tools are rebound before each run.

**Visibility.** Every entry records the chat it was learned in, and that decides
who may see it again:

| Learned in    | Recallable from                                    |
| ------------- | -------------------------------------------------- |
| a group chat  | anywhere — it was said in front of others          |
| a private chat| only a private chat with that same person          |

Without the second rule a bot that remembers usefully also gossips: someone
confides a plan in a DM and the agent repeats it in a team channel a week later.
Cross-chat memory about a person still works — it is the *private* half that
stays private. The rule is enforced on read, not on write, so the record stays
complete and auditable.

Nothing is ever deleted, and the files hold what people said about each other,
so treat `MEMORY_DIR` as sensitive and manage its growth yourself.

### Session persistence

A chat's conversation is kept on disk under `SESSION_DIR` (default
`./sessions`), one transcript per chat, so the same chat reuses the same session
rather than starting over. A session is read back when it is (re)created and
appended to after every run, which means a chat survives eviction, the idle TTL
and a redeploy alike — none of which a user in a chat window has any reason to
experience as amnesia.

The format is pi-agent-core's own JSONL session log: a header line, then one
entry per message on the `main` lane. Using the library's store rather than a
bespoke file keeps the format one its tooling already understands, and leaves
the door open to adopting `AgentHarness` later without migrating anything. Only
a slice of it is written — messages — while branching, compaction records and
usage accounting are things the harness writes and DeepTag does not.

Transcripts are keyed by the chat's workspace directory, which is the `cwd` the
format indexes on:

```
sessions/                              # SESSION_DIR
└── --path-to-workspace-oc_9a3f1c...--/
    └── 2026-08-17T03-18-15-929Z_01a00dba-....jsonl
```

On restore only the last 60 messages are loaded, since that is all a turn would
send anyway; the rest stays on disk as the record. A restored transcript that
would begin with a `toolResult` is trimmed further — without the assistant
message that requested it, the provider rejects it as an orphan.

Everything a run produces is persisted, including on failure, so the file
mirrors the transcript in memory. A turn that errored therefore leaves an empty
assistant message in the history; it is resent until it scrolls out of the
60-message window.

Nothing here is fatal: a transcript that cannot be read or written costs the
conversation its memory, logged as an error, and the user still gets their
reply. Nothing is ever deleted either, so growth on disk is yours to manage —
and note that these files hold whatever users said to the bot.

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
| `SESSION_DIR` | `./sessions`                 | Persisted transcripts, one per chat; created on demand |
| `MEMORY_DIR` | `./memory`                    | Memory about people and chats; created on demand      |
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

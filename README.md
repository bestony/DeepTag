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

| Method | Path      | Description                                                   |
| ------ | --------- | ------------------------------------------------------------- |
| `GET`  | `/`       | Returns `Hono!`                                               |
| `GET`  | `/health` | Health check: status, service, uptime, timestamp, Lark state  |

```sh
curl http://127.0.0.1:3000/health
# {"status":"ok","service":"deeptag","uptime":12.34,"timestamp":"...",
#  "lark":{"enabled":true,"state":"connected","reconnectAttempts":0}}
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

The bot currently replies to each text message with an interactive card echoing
the received text. Non-text messages are logged and ignored. Handler code lives
in `src/lark/events.ts`; connection lifecycle in `src/lark/client.ts`.

Note that `pnpm dev` reconnects on every file change, since `node --watch`
restarts the process.

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
| `LARK_APP_ID` | –                            | Lark app id; must be set together with the secret    |
| `LARK_APP_SECRET` | –                        | Lark app secret; unset disables the bot              |
| `LARK_DOMAIN` | `feishu`                     | `feishu` (mainland China) or `lark` (international)  |

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

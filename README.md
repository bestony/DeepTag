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

| Method | Path      | Description                                     |
| ------ | --------- | ----------------------------------------------- |
| `GET`  | `/`       | Returns `Hono!`                                 |
| `GET`  | `/health` | Health check: status, service, uptime, timestamp |

```sh
curl http://127.0.0.1:3000/health
# {"status":"ok","service":"deeptag","uptime":12.34,"timestamp":"..."}
```

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

/**
 * Workspaces: the directory an agent session works in.
 *
 * Every chat gets its own directory beneath WORKSPACE_DIR, created when that
 * chat's session starts, and every session is handed file and shell tools
 * rooted there. One workspace per chat rather than one shared by all of them,
 * because a shared directory means one conversation can read and overwrite
 * another's files — which, for a bot sitting in a company's group chats, is a
 * confidentiality problem rather than a merely untidy one.
 *
 * Directories outlive sessions. A chat that is evicted from the session
 * registry, or that goes quiet past the TTL, keeps its files: the transcript
 * starting fresh is a memory limit, not an instruction to throw the work away.
 * Nothing here ever deletes a directory.
 *
 * The root is taken as an argument rather than read from `config`, so this can
 * be pointed at a temporary directory in a test.
 */

import { mkdirSync } from "node:fs";
import { resolve, sep } from "node:path";

import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type AgentHarnessTool,
  type AgentTool,
  type ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

import { logger } from "../logger.ts";
import { safeName } from "../safe-name.ts";

export type ChatWorkspace = {
  /**
   * Absolute directory for this chat. Always the intended path, even when it
   * could not be created — callers that only need a stable per-chat identity
   * (the transcript store keys on it) should not have to care.
   */
  readonly dir: string;
  /** False when the directory could not be prepared; tools and prompt are then empty. */
  readonly ready: boolean;
  /** File and shell tools bound to `dir`; empty unless `ready`. */
  readonly tools: readonly AgentTool<any>[];
  /** System prompt block naming the directory; empty unless `ready`. */
  readonly prompt: string;
  /** Kills anything the shell tool still has running. Never rejects. */
  cleanup(): Promise<void>;
};

export type WorkspaceProvider = {
  readonly root: string;
  /** False when the root could not be created; every workspace is then unavailable. */
  readonly ready: boolean;
  /** Opens — creating on first use — the workspace for one chat. Never throws. */
  open(chatId: string): ChatWorkspace;
};

/**
 * What a chat gets when its directory cannot be prepared: no tools, no prompt
 * block, and therefore an agent that answers from the model alone. Degrading
 * this way rather than refusing to start keeps a broken disk from taking the
 * whole bot down, and never leaves the model holding tools that cannot work.
 */
const unavailable = (dir: string): ChatWorkspace => ({
  dir,
  ready: false,
  tools: [],
  prompt: "",
  cleanup: async () => {},
});

/** Tells the model where it is; appended to the session's system prompt. */
const describeWorkspace = (dir: string): string =>
  [
    "<workspace>",
    `Your working directory for this conversation is ${dir}.`,
    "Relative paths given to the read, write, edit and bash tools resolve against it, and relative paths are what you should use.",
    "Keep everything you create for this conversation inside it.",
    "It persists between messages, so files you wrote earlier are still there; other conversations have their own directory and cannot see yours.",
    "</workspace>",
  ].join("\n");

/**
 * Adapts a harness tool — whose `execute` takes the execution context as a
 * trailing argument — to the plain `AgentTool` the agent's tool array expects,
 * by closing over this chat's environment.
 */
const bindTool = (
  tool: AgentHarnessTool<ExecutionToolContext, any, any>,
  context: ExecutionToolContext,
): AgentTool<any> => ({
  ...tool,
  execute: (toolCallId, params, signal, onUpdate) =>
    tool.execute(toolCallId, params, signal, onUpdate, context),
});

const createTools = (
  env: NodeExecutionEnv,
  shellEnv: Readonly<Record<string, string>>,
): AgentTool<any>[] => {
  const context: ExecutionToolContext = { env };

  const bash = createBashTool<ExecutionToolContext>({
    prepare: (execution) => {
      // The default hands the child this process's entire environment, which
      // holds DEEPSEEK_API_KEY and the Lark credentials — one `env` away from
      // being echoed into a chat. Replace it outright rather than deleting
      // known-secret names, so a variable added to .env later is excluded by
      // default instead of by someone remembering to deny it.
      execution.inheritEnv = false;
      execution.env = { ...shellEnv };
    },
  });

  return [
    bindTool(createReadTool(), context),
    bindTool(createWriteTool(), context),
    bindTool(createEditTool(), context),
    bindTool(bash, context),
  ];
};

export const createWorkspaceProvider = (
  root: string,
  shellEnv: Readonly<Record<string, string>>,
): WorkspaceProvider => {
  let ready = true;
  try {
    mkdirSync(root, { recursive: true });
    logger.info("workspace root ready", { root, shellEnvKeys: Object.keys(shellEnv) });
  } catch (err) {
    ready = false;
    logger.error("workspace root could not be created, agent sessions get no tools", {
      root,
      code: (err as NodeJS.ErrnoException).code,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const open = (chatId: string): ChatWorkspace => {
    const dir = resolve(root, safeName(chatId));

    if (!ready) {
      return unavailable(dir);
    }
    // Guaranteed by the slug rule above, so this only fires if that rule is
    // ever loosened — which is exactly when it needs to be caught.
    if (!dir.startsWith(root + sep)) {
      logger.error("workspace path escaped the root, refusing to use it", { chatId, dir, root });
      return unavailable(dir);
    }

    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      logger.error("chat workspace could not be created, this session gets no tools", {
        chatId,
        dir,
        code: (err as NodeJS.ErrnoException).code,
        error: err instanceof Error ? err.message : String(err),
      });
      return unavailable(dir);
    }

    const env = new NodeExecutionEnv({ cwd: dir });

    return {
      dir,
      ready: true,
      tools: createTools(env, shellEnv),
      prompt: describeWorkspace(dir),
      cleanup: async () => {
        try {
          await env.cleanup();
        } catch (err) {
          logger.warn("workspace cleanup failed", {
            dir,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    };
  };

  return { root, ready, open };
};

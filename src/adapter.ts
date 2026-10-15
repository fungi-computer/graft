import * as acp from "@agentclientprotocol/sdk";
import type {
  AssistantMessage,
  ImageContent as PiImageContent,
  Message,
  TextContent as PiTextContent,
  ThinkingContent,
  ToolResultMessage,
} from "@fungi.computer/mule/effect";
import type {
  SessionFrame,
  SessionMessage,
  SessionProgress,
  ShiitakeSession,
  SessionTerminal,
} from "@fungi.computer/shiitake/client";

/** Maintained ACP method descriptors advertised by this agent adapter. */
export const agentAcpMethods = acp.methods.agent;

/** A Session returned by the host's authorization boundary. */
export type AuthorizedShiitakeSession = Readonly<{
  /** Authorized live Session client. */
  session: ShiitakeSession;
  /** Durable identity of the authorized Session. */
  sessionId: string;
  /** Release this ACP client's authorization lease; retain the durable Session. */
  close: () => Promise<void>;
}>;

/** Directory owner used by ACP lifecycle callbacks. */
export type AuthorizedShiitakeSessionDirectory = Readonly<{
  /** Authorize and create a Session with the requested context. */
  create: (input: {
    cwd: string;
    additionalDirectories: readonly string[];
    mcpServers: readonly acp.McpServer[];
    signal: AbortSignal;
  }) => Promise<AuthorizedShiitakeSession>;
  /** Enumerate only Sessions within this host's authorized directory. */
  list?: (input: {
    cwd?: string;
    cursor?: string;
    signal: AbortSignal;
  }) => Promise<acp.ListSessionsResponse>;
  /** Authorize and open an existing Session with the requested context. */
  load: (input: {
    sessionId: string;
    cwd: string;
    additionalDirectories: readonly string[];
    mcpServers: readonly acp.McpServer[];
    signal: AbortSignal;
  }) => Promise<AuthorizedShiitakeSession>;
}>;

/** Host directory, agent identity and lifecycle options for an ACP adapter. */
export type ShiitakeAcpAdapterOptions = Readonly<{
  /** Host-owned Session authorization boundary. */
  directory: AuthorizedShiitakeSessionDirectory;
  /** Agent name reported to the editor. */
  name?: string;
  /** Host login command, appended by clients that support terminal auth. */
  terminalAuth?: acp.AuthMethodTerminal;
  /**
   * How long `session/close` waits for an active prompt to settle after its
   * cancel before detaching the prompt's observation. Defaults to 5 seconds.
   */
  closeSettleMs?: number;
}>;

const DEFAULT_CLOSE_SETTLE_MS = 5_000;

type ActiveTurn = {
  binding: SessionBinding;
  commandId: string | undefined;
  cancelRequested: boolean;
  detached: boolean;
  watch: Awaited<ReturnType<ShiitakeSession["watch"]>> | undefined;
  done: Promise<void>;
  finish: () => void;
};

type SessionBinding = AuthorizedShiitakeSession;
type SessionWatch = Awaited<ReturnType<ShiitakeSession["watch"]>>;
type WatchCloseOutcome =
  | { readonly kind: "closed" }
  | { readonly kind: "failed"; readonly error: Error };
type SessionCloseOutcome =
  | { readonly kind: "closed" }
  | { readonly kind: "failed"; readonly error: Error };

type ConnectionState = {
  sessions: Map<string, SessionBinding>;
  active: Map<string, ActiveTurn>;
  closed: Promise<void> | undefined;
};

type ConnectionLease = {
  state: ConnectionState;
  cleanup: Promise<void> | undefined;
  accepting: boolean;
};

type PiContentPart = PiTextContent | PiImageContent;

function isContentParts(
  content: string | readonly PiContentPart[],
): content is readonly PiContentPart[] {
  return Array.isArray(content);
}

function contentBlocks(
  content: string | readonly PiContentPart[],
): acp.ContentBlock[] {
  return !isContentParts(content)
    ? [acpText(content)]
    : content.map((part) =>
        part.type === "text"
          ? acpText(part.text)
          : { type: "image", data: part.data, mimeType: part.mimeType },
      );
}

function textFromAssistant(content: AssistantMessage["content"]): string {
  return content
    .filter((part): part is PiTextContent => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function thinkingFromAssistant(content: AssistantMessage["content"]): string {
  return content
    .filter((part): part is ThinkingContent => part.type === "thinking")
    .map((part) => part.thinking)
    .join("");
}

function acpText(text: string): acp.ContentBlock {
  return { type: "text", text };
}

function notify(
  client: acp.AgentContext,
  sessionId: string,
  update: acp.SessionUpdate,
): Promise<void> {
  return client.notify(acp.methods.client.session.update, {
    sessionId,
    update,
  });
}

/** Text and thinking already sent for one Shiitake message identity. */
type Streamed = { text: string; thinking: string };

/**
 * What one prompt turn has already sent. ACP clients append every chunk, so
 * each character of a message is sent exactly once: progress sends deltas and
 * the completed message sends only what progress had not yet sent.
 */
type TurnProjection = {
  commandId: string;
  /** Streamed progress, keyed by the message identity it completes under. */
  streamed: Map<string, Streamed>;
  /** Completed messages already projected during this turn. */
  projected: Set<string>;
};

/**
 * Return the part of `next` that extends what was sent. ACP chunks cannot be
 * retracted, so a revision that does not extend the sent text sends nothing.
 */
function unsent(sent: string, next: string): string {
  return next.startsWith(sent) ? next.slice(sent.length) : "";
}

async function projectMessage(
  client: acp.AgentContext,
  sessionId: string,
  message: SessionMessage,
  streamed: Streamed = { text: "", thinking: "" },
): Promise<void> {
  const value: Message = message.value;
  if (value.role === "system") return;
  if (value.role === "user") {
    for (const content of contentBlocks(value.content))
      await notify(client, sessionId, {
        sessionUpdate: "user_message_chunk",
        content,
      });
    return;
  }

  if (value.role === "assistant") {
    const thinking = unsent(
      streamed.thinking,
      thinkingFromAssistant(value.content),
    );
    if (thinking)
      await notify(client, sessionId, {
        sessionUpdate: "agent_thought_chunk",
        content: acpText(thinking),
      });
    const text = unsent(streamed.text, textFromAssistant(value.content));
    if (text)
      await notify(client, sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: acpText(text),
      });
    for (const part of value.content) {
      if (part.type !== "toolCall") continue;
      await notify(client, sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: part.id,
        title: part.name,
        kind: "other",
        status: "in_progress",
        rawInput: part.arguments,
      });
    }
    return;
  }

  const toolResult: ToolResultMessage = value;
  await notify(client, sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: toolResult.toolCallId,
    status: toolResult.isError ? "failed" : "completed",
    content: contentBlocks(toolResult.content).map((content) => ({
      type: "content",
      content,
    })),
    rawOutput: toolResult.details,
  });
}

async function projectProgress(
  client: acp.AgentContext,
  sessionId: string,
  progress: SessionProgress,
  turn: TurnProjection,
): Promise<void> {
  if (turn.projected.has(progress.messageId)) return;
  const sent = turn.streamed.get(progress.messageId) ?? {
    text: "",
    thinking: "",
  };
  const thinking = unsent(sent.thinking, progress.thinking);
  const text = unsent(sent.text, progress.text);
  turn.streamed.set(progress.messageId, {
    text: sent.text + text,
    thinking: sent.thinking + thinking,
  });
  if (thinking)
    await notify(client, sessionId, {
      sessionUpdate: "agent_thought_chunk",
      content: acpText(thinking),
    });
  if (text)
    await notify(client, sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: acpText(text),
    });
}

async function projectTurnMessages(
  client: acp.AgentContext,
  sessionId: string,
  messages: readonly SessionMessage[],
  turn: TurnProjection,
): Promise<void> {
  for (const message of messages) {
    if (message.commandId !== turn.commandId) continue;
    if (turn.projected.has(message.id)) continue;
    turn.projected.add(message.id);
    // The ACP client sent this turn's prompt; echoing it would duplicate it.
    if (message.value.role === "user") continue;
    await projectMessage(
      client,
      sessionId,
      message,
      turn.streamed.get(message.id),
    );
    turn.streamed.delete(message.id);
  }
}

async function projectFrame(
  client: acp.AgentContext,
  sessionId: string,
  frame: SessionFrame,
  turn: TurnProjection,
): Promise<readonly SessionTerminal[]> {
  if (frame.kind === "progress") {
    await projectProgress(client, sessionId, frame.progress, turn);
    return [];
  }

  if (frame.kind === "reset") {
    // A reset replaces the baseline mid-turn. Project this turn's messages
    // that were not already sent; everything else is history. Later progress
    // frames carry cumulative text, so live progress resumes from its delta.
    await projectTurnMessages(client, sessionId, frame.baseline.messages, turn);
    return frame.baseline.terminals;
  }

  await projectTurnMessages(client, sessionId, frame.messages, turn);
  return frame.terminals;
}

function stopReason(outcome: SessionTerminal["outcome"]): acp.StopReason {
  if (outcome === "completed") return "end_turn";
  if (outcome === "cancelled") return "cancelled";
  throw new Error(`Session turn ended with ${outcome}`);
}

function assertSessionId(sessionId: string): void {
  if (sessionId.length === 0)
    throw new Error("The Session owner returned an empty identity");
}

function promptInput(prompt: readonly acp.ContentBlock[]) {
  const text: string[] = [];
  const images: PiImageContent[] = [];
  for (const block of prompt) {
    switch (block.type) {
      case "text":
        text.push(block.text);
        break;
      case "image":
        images.push({
          type: "image",
          data: block.data,
          mimeType: block.mimeType,
        });
        break;
      case "resource_link":
        text.push(
          `\nReferenced resource ${JSON.stringify(block.name)}: ${JSON.stringify(block.uri)}\n`,
        );
        break;
      case "resource": {
        const resource = block.resource;
        text.push(
          `\nResource ${JSON.stringify(resource.uri)} (${resource.mimeType ?? "unspecified"}):\n`,
        );
        if ("text" in resource) text.push(resource.text);
        else if (resource.mimeType?.startsWith("image/") === true)
          images.push({
            type: "image",
            data: resource.blob,
            mimeType: resource.mimeType,
          });
        else
          throw acp.RequestError.invalidParams(
            undefined,
            "Binary resources require a supported image MIME type; send other context as text",
          );
        text.push("\nEnd resource\n");
        break;
      }
      case "audio":
        throw acp.RequestError.invalidParams(
          undefined,
          "Audio prompts are unsupported",
        );
    }
  }
  return { text: text.join(""), images };
}

/** Resolve true when `work` settles within `ms`, false when the bound passes. */
function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        resolve(false);
      }, ms);
    }),
  ]).finally(() => {
    clearTimeout(timer);
  });
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function closeWatchOnce(
  closed: WeakMap<SessionWatch, Promise<void>>,
  watch: SessionWatch,
): Promise<void> {
  const existing = closed.get(watch);
  if (existing) return existing;
  const closing = Promise.resolve().then(() => watch.close());
  closed.set(watch, closing);
  return closing;
}

/** Stop observing a turn; its prompt request then ends as detached. */
function detach(
  turn: ActiveTurn,
  closedWatches: WeakMap<SessionWatch, Promise<void>>,
): Promise<WatchCloseOutcome> {
  turn.detached = true;
  if (turn.watch === undefined) return Promise.resolve({ kind: "closed" });
  return closeWatchOnce(closedWatches, turn.watch).then(
    () => ({ kind: "closed" }),
    (cause: unknown) => ({ kind: "failed", error: asError(cause) }),
  );
}

/** Re-read teardown state after an asynchronous owner operation. */
function assertPromptAttached(turn: ActiveTurn, state: ConnectionState): void {
  if (turn.detached || state.closed !== undefined)
    throw new Error("The ACP connection closed before prompt admission");
}

function closeOnce(
  closed: WeakMap<SessionBinding, Promise<void>>,
  binding: SessionBinding,
): Promise<void> {
  const existing = closed.get(binding);
  if (existing) return existing;
  const closing = Promise.resolve().then(() => binding.close());
  closed.set(binding, closing);
  return closing;
}

/**
 * Projects ACP stable v1 onto Sessions from one host-authorized directory.
 *
 * The host directory owns Session creation/loading and authorization. ACP
 * request IDs are retained for correlation while Shiitake generates its own
 * idempotency key and returns its own accepted command ID.
 */
export function createShiitakeAcpAgent(
  options: ShiitakeAcpAdapterOptions,
): acp.AgentApp {
  const { directory } = options;
  const closeSettleMs = options.closeSettleMs ?? DEFAULT_CLOSE_SETTLE_MS;
  const closedBindings = new WeakMap<SessionBinding, Promise<void>>();
  const closedWatches = new WeakMap<SessionWatch, Promise<void>>();
  const app = acp.agent({ name: options.name ?? "Shiitake" });
  let connectionLease: ConnectionLease | undefined;

  function stateFor(): ConnectionState {
    const state = connectionLease?.state;
    if (!state || !connectionLease?.accepting)
      throw new Error("The ACP connection is not active");
    return state;
  }

  /** Retain a binding, or release it when the connection closed meanwhile. */
  async function retain(
    state: ConnectionState,
    binding: SessionBinding,
  ): Promise<void> {
    if (state.closed) {
      await closeOnce(closedBindings, binding);
      throw new Error("The ACP connection closed");
    }
    state.sessions.set(binding.sessionId, binding);
  }

  async function closeConnection(state: ConnectionState): Promise<void> {
    if (state.closed) return state.closed;
    state.closed = (async () => {
      const watchOutcomes = await Promise.all(
        [...state.active.values()].map((turn) => detach(turn, closedWatches)),
      );
      const leaseOutcomes: SessionCloseOutcome[] = await Promise.all(
        [...state.sessions.values()].map((binding) =>
          closeOnce(closedBindings, binding).then(
            () => ({ kind: "closed" as const }),
            (cause: unknown) => ({
              kind: "failed" as const,
              error: asError(cause),
            }),
          ),
        ),
      );
      state.active.clear();
      state.sessions.clear();
      const failures = [...watchOutcomes, ...leaseOutcomes]
        .filter((outcome) => outcome.kind === "failed")
        .map((outcome) => outcome.error);
      const firstFailure = failures[0];
      if (failures.length === 1 && firstFailure !== undefined)
        throw firstFailure;
      if (firstFailure !== undefined) {
        throw new AggregateError(failures, "ACP connection cleanup failed", {
          cause: firstFailure,
        });
      }
    })();
    return state.closed;
  }

  app.onConnect(async (connection) => {
    const previous = connectionLease;
    if (previous) {
      if (!previous.cleanup) {
        connection.close(
          new Error("This ACP AgentApp already has a connection"),
        );
        return;
      }
      previous.accepting = false;
      await previous.cleanup;
      if (connectionLease && connectionLease !== previous) {
        connection.close(
          new Error("This ACP AgentApp already has a connection"),
        );
        return;
      }
    }
    const state: ConnectionState = {
      sessions: new Map(),
      active: new Map(),
      closed: undefined,
    };
    const lease: ConnectionLease = {
      state,
      cleanup: undefined,
      accepting: true,
    };
    connectionLease = lease;
    let finished: Promise<void> | undefined;
    const finish = (): Promise<void> => {
      if (finished) return finished;
      lease.accepting = false;
      finished = closeConnection(state).then(() => {
        if (connectionLease === lease) connectionLease = undefined;
      });
      lease.cleanup = finished;
      return finished;
    };
    connection.signal.addEventListener("abort", () => void finish(), {
      once: true,
    });
    void connection.closed.then(finish);
  });

  app.onRequest(acp.methods.agent.initialize, (ctx) => {
    const sessionCapabilities: acp.SessionCapabilities = { close: {} };
    if (directory.list !== undefined) sessionCapabilities.list = {};
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      authMethods:
        options.terminalAuth !== undefined &&
        ctx.params.clientCapabilities?.auth?.terminal === true
          ? [{ ...options.terminalAuth, type: "terminal" }]
          : [],
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities,
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true,
        },
      },
    };
  });

  if (directory.list !== undefined) {
    const list = directory.list;
    app.onRequest(acp.methods.agent.session.list, (ctx) => {
      const input: Parameters<typeof list>[0] = { signal: ctx.signal };
      if (ctx.params.cwd != null) input.cwd = ctx.params.cwd;
      if (ctx.params.cursor != null) input.cursor = ctx.params.cursor;
      return list(input);
    });
  }

  app.onRequest(acp.methods.agent.session.new, async (ctx) => {
    const state = stateFor();
    const binding = await directory.create({
      cwd: ctx.params.cwd,
      additionalDirectories: ctx.params.additionalDirectories ?? [],
      mcpServers: ctx.params.mcpServers,
      signal: ctx.signal,
    });
    assertSessionId(binding.sessionId);
    if (state.sessions.has(binding.sessionId)) {
      await closeOnce(closedBindings, binding);
      throw new Error(
        "The Session owner returned a duplicate Session identity",
      );
    }
    await retain(state, binding);
    return { sessionId: binding.sessionId };
  });

  app.onRequest(acp.methods.agent.session.load, async (ctx) => {
    const state = stateFor();
    const binding = await directory.load({
      sessionId: ctx.params.sessionId,
      cwd: ctx.params.cwd,
      additionalDirectories: ctx.params.additionalDirectories ?? [],
      mcpServers: ctx.params.mcpServers,
      signal: ctx.signal,
    });
    assertSessionId(binding.sessionId);
    if (binding.sessionId !== ctx.params.sessionId) {
      await closeOnce(closedBindings, binding);
      throw new Error(
        "The Session owner returned a different Session identity",
      );
    }
    const existing = state.sessions.get(binding.sessionId);
    if (existing && state.active.has(binding.sessionId)) {
      if (existing !== binding) await closeOnce(closedBindings, binding);
      throw new Error("This ACP Session has an active prompt");
    }
    try {
      const snapshot = await binding.session.read();
      if (snapshot.sessionId !== binding.sessionId)
        throw new Error("The Session returned a different identity");
      for (const message of snapshot.messages)
        await projectMessage(ctx.client, binding.sessionId, message);
    } catch (error) {
      await closeOnce(closedBindings, binding);
      throw error;
    }
    if (existing && existing !== binding)
      await closeOnce(closedBindings, existing);
    await retain(state, binding);
    return {};
  });

  app.onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const state = stateFor();
    const binding = state.sessions.get(ctx.params.sessionId);
    if (!binding) throw new Error("The requested Session is not authorized");
    if (state.active.has(binding.sessionId))
      throw new Error("This ACP Session already has an active prompt");

    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const turn: ActiveTurn = {
      binding,
      commandId: undefined,
      cancelRequested: false,
      detached: false,
      watch: undefined,
      done,
      finish,
    };
    state.active.set(binding.sessionId, turn);
    try {
      const watch = await binding.session.watch();
      turn.watch = watch;
      // Disconnect may have detached the turn while its watch was opening.
      // The finally block closes this late watch without admitting a prompt.
      assertPromptAttached(turn, state);
      if (watch.snapshot.sessionId !== binding.sessionId)
        throw new Error("The Session returned a different identity");
      // Do not use the ACP JSON-RPC ID as Shiitake's idempotency key. The host
      // owns that correlation boundary; this call lets Shiitake generate it.
      const input = promptInput(ctx.params.prompt);
      const accepted = await binding.session.send(
        input.text,
        input.images.length === 0 ? undefined : { images: input.images },
      );
      turn.commandId = accepted.commandId;
      if (turn.cancelRequested)
        await binding.session.cancel({ commandId: accepted.commandId });

      const projection: TurnProjection = {
        commandId: accepted.commandId,
        streamed: new Map(),
        projected: new Set(),
      };
      for await (const frame of watch.changes) {
        const terminals = await projectFrame(
          ctx.client,
          binding.sessionId,
          frame,
          projection,
        );
        const terminal = terminals.find(
          (candidate) => candidate.commandId === accepted.commandId,
        );
        if (terminal) return { stopReason: stopReason(terminal.outcome) };
      }
      if (turn.detached)
        throw new Error("ACP observation detached before terminal settlement");
      throw new Error("Session observation ended before terminal settlement");
    } finally {
      if (state.active.get(binding.sessionId) === turn)
        state.active.delete(binding.sessionId);
      try {
        if (turn.watch !== undefined)
          await closeWatchOnce(closedWatches, turn.watch);
      } finally {
        turn.finish();
      }
    }
  });

  app.onRequest(acp.methods.agent.session.close, async (ctx) => {
    const state = stateFor();
    const binding = state.sessions.get(ctx.params.sessionId);
    if (!binding) throw new Error("The requested Session is not authorized");
    const turn = state.active.get(binding.sessionId);
    let watchClose: WatchCloseOutcome = { kind: "closed" };
    if (turn) {
      turn.cancelRequested = true;
      const { commandId } = turn;
      const settled = await settlesWithin(
        (async () => {
          if (commandId !== undefined)
            await binding.session.cancel({ commandId });
          await turn.done;
        })(),
        closeSettleMs,
      );
      // The owner did not settle the cancel in time: stop observing so the
      // close completes; the prompt request ends as detached.
      if (!settled) watchClose = await detach(turn, closedWatches);
    }
    state.sessions.delete(binding.sessionId);
    const leaseClose: SessionCloseOutcome = await closeOnce(
      closedBindings,
      binding,
    ).then(
      () => ({ kind: "closed" }),
      (cause: unknown) => ({ kind: "failed", error: asError(cause) }),
    );
    if (watchClose.kind === "failed") {
      if (leaseClose.kind === "failed") {
        throw new AggregateError(
          [watchClose.error, leaseClose.error],
          "ACP watch and session lease cleanup failed",
          { cause: watchClose.error },
        );
      }
      throw watchClose.error;
    }
    if (leaseClose.kind === "failed") throw leaseClose.error;
    return {};
  });

  app.onNotification(acp.methods.agent.session.cancel, async (ctx) => {
    const state = stateFor();
    const binding = state.sessions.get(ctx.params.sessionId);
    if (!binding) return;
    const turn = state.active.get(binding.sessionId);
    if (!turn) return;
    turn.cancelRequested = true;
    if (turn.commandId !== undefined)
      await binding.session.cancel({ commandId: turn.commandId });
  });

  return app;
}

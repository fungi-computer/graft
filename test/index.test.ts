import * as acp from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import type { AssistantMessage, Message } from "@fungi.computer/mule/effect";
import type {
  SendOptions,
  SessionActivity,
  ShiitakeAgent,
  SessionFrame,
  SessionMessage,
  ShiitakeSession,
} from "@fungi.computer/shiitake/client";
import { createShiitakeAcpAgent } from "../src/index.js";
import type { AuthorizedShiitakeSessionDirectory } from "../src/index.js";
import { createAuthorizedShiitakeSessionDirectory } from "../src/session-directory.js";
import { createShiitakeAcpServer } from "../src/server.js";
import { describe, expect, it } from "vitest";

const idleActivity: SessionActivity = {
  queue: { state: "idle" },
  cancellationRequested: false,
  retry: null,
  activeTool: null,
  lastModelChoiceSequence: null,
  compaction: null,
};

function runningActivity(
  overrides: Partial<SessionActivity> = {},
): SessionActivity {
  return {
    ...idleActivity,
    queue: { state: "running", commandId: "running-command" },
    ...overrides,
  };
}

type Mode = "complete" | "deferred" | "reset" | "silent" | "tool";

type Fixture = {
  binding: {
    session: ShiitakeSession;
    sessionId: string;
    close: () => Promise<void>;
  };
  mode: Mode;
  sent: string[];
  sentOptions: (SendOptions | undefined)[];
  cancelled: string[];
  admit: () => void;
  history: SessionMessage[];
  closed: number;
  watchClosed: number;
  watchOpened: number;
  aborted: number;
  queuedCommandId: string | undefined;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; !condition(); attempt += 1) {
    if (attempt > 1_000) throw new Error("waitFor condition never held");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function message(
  value: Message,
  commandId: string | null,
  sequence = 1,
  id = `message-${String(sequence)}`,
): SessionMessage {
  return { id, sequence, commandId, value };
}

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  timestamp: number,
): Message {
  return {
    role: "assistant",
    content,
    api: "test",
    provider: "test",
    model: "test",
    responseId: `response-${String(timestamp)}`,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp,
  };
}

/** The prompt entry Shiitake records under the accepted command. */
function promptEntry(text: string, commandId: string): SessionMessage {
  return message(
    { role: "user", content: text, timestamp: 2 },
    commandId,
    2,
    `${commandId}-prompt`,
  );
}

function progressFrame(
  revision: number,
  text: string,
  thinking: string,
  textOffset = 0,
  thinkingOffset = 0,
): SessionFrame {
  return {
    kind: "progress",
    activity: runningActivity(),
    progress: {
      messageId: "reply-1",
      revision,
      text: { offset: textOffset, append: text },
      thinking: { offset: thinkingOffset, append: thinking },
    },
  };
}

function fixture(
  sessionId: string,
  mode: Mode = "complete",
  watchCloseFailure?: Error,
): Fixture {
  const frames: SessionFrame[] = [];
  const waiting: (() => void)[] = [];
  const sent: string[] = [];
  const sentOptions: (SendOptions | undefined)[] = [];
  const cancelled: string[] = [];
  let closed = 0;
  let watchOpen = false;
  let watchClosed = 0;
  let watchOpened = 0;
  let aborted = 0;
  let queuedCommandId: string | undefined = `${sessionId}-queued-command`;
  let commandNumber = 0;
  let admitted: (() => void) | undefined;
  const oldPrompt = {
    role: "user",
    content: "old prompt",
    timestamp: 1,
  } as const satisfies Message;
  const history = [message(oldPrompt, null)];
  const unusedCommand = (): Promise<never> =>
    Promise.reject(new Error("unused fixture command"));

  function emit(frame: SessionFrame): void {
    frames.push(frame);
    waiting.splice(0).forEach((resolve) => {
      resolve();
    });
  }

  function terminal(
    commandId: string,
    outcome: "cancelled" | "completed",
  ): void {
    emit({
      kind: "update",
      delivery: "live",
      cursor: `${commandId}-cursor`,
      pending: { total: 0, prompts: [], hasMore: false },
      messages: [],
      terminals: [{ commandId, outcome, sequence: 3, diagnostic: null }],
      activity: idleActivity,
      extensions: {},
      attention: [],
    });
  }

  const session: ShiitakeSession = {
    address: `test://shiitake/${sessionId}`,
    command: unusedCommand,
    readSettlement: unusedCommand,
    withdraw: unusedCommand,
    latestPending: () => Promise.resolve(null),
    extension: () => ({ call: unusedCommand }),
    abort: () => {
      aborted += 1;
      queuedCommandId = undefined;
      return Promise.resolve();
    },
    cancel: ({ commandId }) => {
      cancelled.push(commandId);
      if (admitted) admitted();
      if (mode !== "silent") terminal(commandId, "cancelled");
      return Promise.resolve({ status: "accepted", commandId });
    },
    send: (text, options) => {
      sent.push(text);
      sentOptions.push(options);
      const commandId = `${sessionId}-command-${String(++commandNumber)}`;
      if (mode === "deferred") {
        const accepted = deferred<{ status: "accepted"; commandId: string }>();
        admitted = () => {
          admitted = undefined;
          accepted.resolve({ status: "accepted", commandId });
        };
        return accepted.promise;
      }
      if (mode === "silent") {
        // The owner admits the prompt and never settles it.
      } else if (mode === "reset") {
        // History is lost mid-turn: progress streamed, then a replacement
        // baseline carries the completed reply and its terminal.
        emit(progressFrame(1, "Hel", ""));
        emit({
          kind: "reset",
          reason: "history_unavailable",
          cursor: "replacement",
          baseline: {
            sessionId,
            cursor: "replacement",
            hasMore: false,
            messages: [
              ...history,
              promptEntry(text, commandId),
              message(
                assistant([{ type: "text", text: "Hello" }], "stop", 3),
                commandId,
                3,
                "reply-1",
              ),
            ],
            terminals: [
              {
                commandId,
                outcome: "completed",
                sequence: 3,
                diagnostic: null,
              },
            ],
            pending: { total: 0, prompts: [], hasMore: false },
            activity: idleActivity,
            toolOutput: [],
            progress: null,
            extensions: {},
            attention: [],
          },
        });
      } else if (mode === "tool") {
        emit({
          kind: "update",
          delivery: "live",
          cursor: "tool-start",
          pending: { total: 0, prompts: [], hasMore: false },
          messages: [
            message(
              assistant(
                [
                  {
                    type: "toolCall",
                    id: "tool-1",
                    name: "lookup",
                    arguments: { query: "x" },
                  },
                ],
                "toolUse",
                2,
              ),
              commandId,
            ),
          ],
          terminals: [],
          activity: runningActivity({ activeTool: "lookup" }),
          extensions: {},
          attention: [],
        });
        emit({
          kind: "update",
          delivery: "live",
          cursor: "tool-result",
          pending: { total: 0, prompts: [], hasMore: false },
          messages: [
            message(
              {
                role: "toolResult",
                toolCallId: "tool-1",
                toolName: "lookup",
                content: [{ type: "text", text: "result" }],
                isError: false,
                timestamp: 3,
              } as const satisfies Message,
              commandId,
              3,
            ),
          ],
          terminals: [
            { commandId, outcome: "completed", sequence: 3, diagnostic: null },
          ],
          activity: idleActivity,
          extensions: {},
          attention: [],
        });
      } else {
        // The prompt entry, offset/append progress, then exact completion.
        emit({
          kind: "update",
          delivery: "live",
          cursor: `${commandId}-prompt`,
          pending: { total: 0, prompts: [], hasMore: false },
          messages: [promptEntry(text, commandId)],
          terminals: [],
          activity: runningActivity(),
          extensions: {},
          attention: [],
        });
        emit(progressFrame(1, "", "Let"));
        emit(progressFrame(2, "Hel", " me", 0, 3));
        emit(progressFrame(3, "lo", " think", 3, 6));
        emit({
          kind: "update",
          delivery: "live",
          cursor: `${commandId}-reply`,
          pending: { total: 0, prompts: [], hasMore: false },
          messages: [
            message(
              assistant(
                [
                  { type: "thinking", thinking: "Let me think" },
                  { type: "text", text: "Hello, world" },
                ],
                "stop",
                3,
              ),
              commandId,
              3,
              "reply-1",
            ),
          ],
          terminals: [
            { commandId, outcome: "completed", sequence: 3, diagnostic: null },
          ],
          activity: idleActivity,
          extensions: {},
          attention: [],
        });
      }
      return Promise.resolve({ status: "accepted", commandId });
    },
    modelPreference: {
      read: () => Promise.resolve(null),
      set: () => Promise.resolve(),
    },
    read: () =>
      Promise.resolve({
        sessionId,
        cursor: null,
        hasMore: false,
        messages: history,
        terminals: [],
        pending: { total: 0, prompts: [], hasMore: false },
        activity: idleActivity,
        toolOutput: [],
        progress: null,
        extensions: {},
        attention: [],
      }),
    subscribe: () => framesFromQueue(),
    watch: () => {
      watchOpen = true;
      watchOpened += 1;
      return Promise.resolve({
        snapshot: {
          sessionId,
          cursor: null,
          hasMore: false,
          messages: [],
          terminals: [],
          pending: { total: 0, prompts: [], hasMore: false },
          activity: idleActivity,
          toolOutput: [],
          progress: null,
          extensions: {},
          attention: [],
        },
        changes: framesFromQueue(),
        close: () => {
          if (watchOpen) {
            watchOpen = false;
            watchClosed += 1;
            waiting.splice(0).forEach((resolve) => {
              resolve();
            });
          }
          return watchCloseFailure
            ? Promise.reject(watchCloseFailure)
            : Promise.resolve();
        },
      });
    },
  };

  async function* framesFromQueue(): AsyncIterable<SessionFrame> {
    for (;;) {
      if (!isWatchOpen()) return;
      if (frames.length === 0)
        await new Promise<void>((resolve) => waiting.push(resolve));
      if (!isWatchOpen()) return;
      const frame = frames.shift();
      if (frame) yield frame;
    }
  }

  function isWatchOpen(): boolean {
    return watchOpen;
  }

  return {
    binding: {
      session,
      sessionId,
      close: () => {
        closed += 1;
        return Promise.resolve();
      },
    },
    mode,
    sent,
    sentOptions,
    cancelled,
    admit: () => admitted?.(),
    history,
    get closed() {
      return closed;
    },
    get watchClosed() {
      return watchClosed;
    },
    get watchOpened() {
      return watchOpened;
    },
    get aborted() {
      return aborted;
    },
    get queuedCommandId() {
      return queuedCommandId;
    },
  };
}

function directory(
  fixtures: Map<string, Fixture>,
): AuthorizedShiitakeSessionDirectory {
  let next = 0;
  return {
    create: () => {
      const value = fixture(`session-${String(++next)}`);
      fixtures.set(value.binding.sessionId, value);
      return Promise.resolve(value.binding);
    },
    load: ({ sessionId }) => {
      const value = fixtures.get(sessionId);
      if (!value) return Promise.reject(new Error("unauthorized Session"));
      return Promise.resolve(value.binding);
    },
  };
}

async function initialize(ctx: acp.ClientContext): Promise<void> {
  const result = await ctx.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
  });
  expect(result.protocolVersion).toBe(acp.PROTOCOL_VERSION);
  expect(result.agentCapabilities?.promptCapabilities).toEqual({
    image: true,
    audio: false,
    embeddedContext: true,
  });
  expect(result.agentCapabilities?.sessionCapabilities).toEqual({ close: {} });
}

async function loadExisting(
  ctx: acp.ClientContext,
  sessionId: string,
): Promise<void> {
  await ctx.request(acp.methods.agent.session.load, {
    sessionId,
    cwd: "/workspace",
    mcpServers: [],
  });
}

const unused = (): Promise<never> =>
  Promise.reject(new Error("unused fixture command"));

describe("Shiitake ACP v1 adapter", () => {
  it("creates one request key for each ACP Session create operation", async () => {
    const created = fixture("session-created");
    const requestIds: string[] = [];
    const client: ShiitakeAgent = {
      createSession: (requestId) => {
        requestIds.push(requestId);
        return Promise.resolve(created.binding.sessionId);
      },
      deleteSession: () => Promise.resolve(false),
      listSessions: () => Promise.resolve({ sessions: [], next: undefined }),
      extensions: { list: unused, resume: unused, call: unused },
      session: () => created.binding.session,
      close: () => Promise.resolve(),
    };
    const directory = createAuthorizedShiitakeSessionDirectory({
      openClient: () =>
        Promise.resolve({ client, close: () => Promise.resolve() }),
    });
    const input = {
      cwd: "/workspace",
      additionalDirectories: [],
      mcpServers: [],
      signal: new AbortController().signal,
    };

    const first = await directory.create(input);
    const second = await directory.create(input);
    await Promise.all([first.close(), second.close()]);

    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).toMatch(/^request_[a-z0-9]{21}$/u);
    expect(requestIds[1]).not.toBe(requestIds[0]);
  });

  it("serves the adapter over the maintained Streamable HTTP transport", async () => {
    const fixtures = new Map<string, Fixture>();
    const server = createShiitakeAcpServer(directory(fixtures));
    const requests: Request[] = [];
    const stream = createHttpStream("https://agent.test/acp", {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        return server.handleRequest(request);
      },
    });

    try {
      await acp
        .client({ name: "http-client" })
        .connectWith(stream, async (ctx) => {
          await initialize(ctx);
          const created = await ctx.request(acp.methods.agent.session.new, {
            cwd: "/workspace",
            mcpServers: [],
          });
          expect(created.sessionId).toBe("session-1");
        });
    } finally {
      await stream.writable.close();
      await server.close();
    }

    expect(
      requests.some(
        (request) =>
          request.method === "GET" && request.headers.has("Acp-Connection-Id"),
      ),
    ).toBe(true);
    expect(
      requests.some(
        (request) =>
          request.method === "GET" && request.headers.has("Acp-Session-Id"),
      ),
    ).toBe(true);
  });

  it("creates, loads, replays, and prompts existing owner Sessions", async () => {
    const fixtures = new Map<string, Fixture>();
    const agent = createShiitakeAcpAgent({ directory: directory(fixtures) });
    const updates: acp.SessionUpdate[] = [];

    await acp
      .client({ name: "proof-client" })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        updates.push(params.update);
      })
      .connectWith(agent, async (ctx) => {
        await initialize(ctx);
        const created = await ctx.request(acp.methods.agent.session.new, {
          cwd: "/workspace",
          mcpServers: [],
        });
        await ctx.request(acp.methods.agent.session.load, {
          sessionId: created.sessionId,
          cwd: "/workspace",
          mcpServers: [],
        });
        const result = await ctx.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: "text", text: "new prompt" }],
        });
        expect(result.stopReason).toBe("end_turn");
      });

    const chunk = (
      sessionUpdate: "agent_message_chunk" | "agent_thought_chunk",
      text: string,
    ) => ({ sessionUpdate, content: { type: "text", text } });
    expect(fixtures.get("session-1")?.sent).toEqual(["new prompt"]);
    expect(updates).toEqual([
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "old prompt" },
      },
      chunk("agent_thought_chunk", "Let"),
      chunk("agent_thought_chunk", " me"),
      chunk("agent_message_chunk", "Hel"),
      chunk("agent_thought_chunk", " think"),
      chunk("agent_message_chunk", "lo"),
      chunk("agent_message_chunk", ", world"),
    ]);
  });

  it("sends streamed text and thinking once across progress and the completed message", async () => {
    const fixtures = new Map<string, Fixture>();
    const agent = createShiitakeAcpAgent({ directory: directory(fixtures) });
    const updates: acp.SessionUpdate[] = [];
    await acp
      .client({ name: "stream-client" })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        updates.push(params.update);
      })
      .connectWith(agent, async (ctx) => {
        await initialize(ctx);
        const created = await ctx.request(acp.methods.agent.session.new, {
          cwd: "/workspace",
          mcpServers: [],
        });
        await ctx.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: "text", text: "stream" }],
        });
      });
    const joined = (kind: acp.SessionUpdate["sessionUpdate"]) =>
      updates
        .flatMap((update) =>
          update.sessionUpdate === kind &&
          "content" in update &&
          !Array.isArray(update.content) &&
          update.content?.type === "text"
            ? [update.content.text]
            : [],
        )
        .join("");
    expect(joined("agent_message_chunk")).toBe("Hello, world");
    expect(joined("agent_thought_chunk")).toBe("Let me think");
    // The client's own prompt is not echoed back during its turn.
    expect(joined("user_message_chunk")).toBe("");
  });

  it("keeps two ACP Sessions independent", async () => {
    const fixtures = new Map<string, Fixture>();
    const owner = directory(fixtures);
    const firstAgent = createShiitakeAcpAgent({
      directory: owner,
    });
    const secondAgent = createShiitakeAcpAgent({
      directory: owner,
    });
    const run = (agent: acp.AgentApp, name: string) =>
      acp.client({ name }).connectWith(agent, async (ctx) => {
        await initialize(ctx);
        const created = await ctx.request(acp.methods.agent.session.new, {
          cwd: "/workspace",
          mcpServers: [],
        });
        return ctx.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: "text", text: name }],
        });
      });
    const results = await Promise.all([
      run(firstAgent, "one"),
      run(secondAgent, "two"),
    ]);
    expect(results.map((result) => result.stopReason)).toEqual([
      "end_turn",
      "end_turn",
    ]);
    expect(fixtures.get("session-1")?.sent).toEqual(["one"]);
    expect(fixtures.get("session-2")?.sent).toEqual(["two"]);
  });

  it("isolates equal Session IDs across ACP connections", async () => {
    const one = fixture("shared");
    const two = fixture("shared");
    const pending = [one.binding, two.binding];
    const sharedDirectory: AuthorizedShiitakeSessionDirectory = {
      create: () => {
        const binding = pending.shift();
        return binding
          ? Promise.resolve(binding)
          : Promise.reject(new Error("unexpected create"));
      },
      load: () => Promise.reject(new Error("unused load")),
    };
    const firstAgent = createShiitakeAcpAgent({
      directory: sharedDirectory,
    });
    const secondAgent = createShiitakeAcpAgent({
      directory: sharedDirectory,
    });
    const run = (agent: acp.AgentApp, name: string) =>
      acp.client({ name }).connectWith(agent, async (ctx) => {
        await initialize(ctx);
        const created = await ctx.request(acp.methods.agent.session.new, {
          cwd: "/workspace",
          mcpServers: [],
        });
        return ctx.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: "text", text: name }],
        });
      });
    await Promise.all([run(firstAgent, "one"), run(secondAgent, "two")]);
    expect(one.sent).toEqual(["one"]);
    expect(two.sent).toEqual(["two"]);
  });

  it("rejects concurrent reuse of one AgentApp and permits later reuse", async () => {
    const fixtures = new Map<string, Fixture>();
    const agent = createShiitakeAcpAgent({ directory: directory(fixtures) });
    const first = acp.client({ name: "first" }).connect(agent);
    await first.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
    });
    const second = acp.client({ name: "second" }).connect(agent);
    const rejected = await second.agent
      .request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
      })
      .then(
        () => false,
        () => true,
      );
    expect(rejected).toBe(true);
    await second.closed;
    first.close();
    await first.closed;

    const later = acp.client({ name: "later" }).connect(agent);
    await later.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
    });
    later.close();
    await later.closed;
  });

  it("cancels before and after owner admission", async () => {
    for (const beforeAdmission of [true, false]) {
      const fixtures = new Map<string, Fixture>();
      const deferredFixture = fixture("session-1", "deferred");
      fixtures.set("session-1", deferredFixture);
      const agent = createShiitakeAcpAgent({ directory: directory(fixtures) });
      await acp
        .client({ name: "cancel-client" })
        .connectWith(agent, async (ctx) => {
          await initialize(ctx);
          await loadExisting(ctx, "session-1");
          const prompt = ctx.request(acp.methods.agent.session.prompt, {
            sessionId: "session-1",
            prompt: [{ type: "text", text: "cancel me" }],
          });
          await waitFor(() => deferredFixture.sent.length === 1);
          if (!beforeAdmission) deferredFixture.admit();
          const cancel = ctx.notify(acp.methods.agent.session.cancel, {
            sessionId: "session-1",
          });
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (beforeAdmission) deferredFixture.admit();
          await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
          await cancel;
        });
      expect(deferredFixture.cancelled).toEqual(["session-1-command-1"]);
    }
  });

  it("closes an ACP lease after settling its active prompt", async () => {
    const active = fixture("session-1", "deferred");
    const agent = createShiitakeAcpAgent({
      directory: {
        create: () => Promise.resolve(active.binding),
        load: () => Promise.resolve(active.binding),
      },
    });
    await acp
      .client({ name: "close-client" })
      .connectWith(agent, async (ctx) => {
        await initialize(ctx);
        await ctx.request(acp.methods.agent.session.new, {
          cwd: "/workspace",
          mcpServers: [],
        });
        const prompt = ctx.request(acp.methods.agent.session.prompt, {
          sessionId: "session-1",
          prompt: [{ type: "text", text: "close me" }],
        });
        await waitFor(() => active.sent.length === 1);
        active.admit();
        await expect(
          ctx.request(acp.methods.agent.session.close, {
            sessionId: "session-1",
          }),
        ).resolves.toEqual({});
        await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
      });
    expect(active.cancelled).toEqual(["session-1-command-1"]);
    expect(active.closed).toBe(1);
  });

  it("targets only the admitted command when close waits for admission", async () => {
    const active = fixture("session-1", "deferred");
    const agent = createShiitakeAcpAgent({
      directory: {
        create: () => Promise.resolve(active.binding),
        load: () => Promise.resolve(active.binding),
      },
    });
    await acp
      .client({ name: "pending-close-client" })
      .connectWith(agent, async (ctx) => {
        await initialize(ctx);
        await ctx.request(acp.methods.agent.session.new, {
          cwd: "/workspace",
          mcpServers: [],
        });
        const prompt = ctx.request(acp.methods.agent.session.prompt, {
          sessionId: "session-1",
          prompt: [{ type: "text", text: "wait for admission" }],
        });
        await waitFor(() => active.sent.length === 1);
        const close = ctx.request(acp.methods.agent.session.close, {
          sessionId: "session-1",
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        active.admit();
        await expect(close).resolves.toEqual({});
        await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
      });
    expect(active.cancelled).toEqual(["session-1-command-1"]);
    expect(active.aborted).toBe(0);
    expect(active.queuedCommandId).toBe("session-1-queued-command");
  });

  it("closes connection leases while retaining the durable Session", async () => {
    const active = fixture("session-1", "deferred");
    const agent = createShiitakeAcpAgent({
      directory: {
        create: () => Promise.resolve(active.binding),
        load: () => Promise.resolve(active.binding),
      },
    });
    const connection = acp.client({ name: "transport-client" }).connect(agent);
    await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
    });
    await connection.agent.request(acp.methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
    });
    const prompt = connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId: "session-1",
      prompt: [{ type: "text", text: "detach" }],
    });
    await waitFor(() => active.sent.length === 1);
    active.admit();
    await waitFor(() => active.watchOpened === 1);
    connection.close();
    await connection.closed;
    await waitFor(() => active.closed === 1);
    await waitFor(() => active.watchClosed === 1);
    await expect(prompt).rejects.toThrow();
    expect(active.closed).toBe(1);
    expect(active.watchClosed).toBe(1);
    expect(active.cancelled).toEqual([]);
    expect(active.aborted).toBe(0);
  });

  it("closes a late watch after disconnect without admitting a prompt", async () => {
    const active = fixture("session-1");
    const opened = deferred<Awaited<ReturnType<ShiitakeSession["watch"]>>>();
    const watch = active.binding.session.watch;
    let opening = false;
    active.binding.session = {
      ...active.binding.session,
      watch: () => {
        opening = true;
        return opened.promise;
      },
    };
    const agent = createShiitakeAcpAgent({
      directory: {
        create: () => Promise.resolve(active.binding),
        load: () => Promise.resolve(active.binding),
      },
    });
    const connection = acp.client({ name: "late-watch-client" }).connect(agent);
    await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
    });
    await connection.agent.request(acp.methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
    });
    const outcome = connection.agent
      .request(acp.methods.agent.session.prompt, {
        sessionId: "session-1",
        prompt: [{ type: "text", text: "must not be admitted" }],
      })
      .then(
        () => "completed",
        () => "disconnected",
      );
    await waitFor(() => opening);
    connection.close();
    await connection.closed;
    await waitFor(() => active.closed === 1);
    opened.resolve(await watch());
    await waitFor(() => active.watchClosed === 1);
    expect(await outcome).toBe("disconnected");
    expect(active.sent).toEqual([]);
    expect(active.cancelled).toEqual([]);
    expect(active.aborted).toBe(0);
  });

  it("rejects load replacement while a prompt is active and closes it", async () => {
    const active = fixture("session-1", "deferred");
    const replacement = fixture("session-1");
    const agent = createShiitakeAcpAgent({
      directory: {
        create: () => Promise.resolve(active.binding),
        load: () => Promise.resolve(replacement.binding),
      },
    });
    await acp
      .client({ name: "reload-client" })
      .connectWith(agent, async (ctx) => {
        await initialize(ctx);
        await ctx.request(acp.methods.agent.session.new, {
          cwd: "/workspace",
          mcpServers: [],
        });
        const prompt = ctx.request(acp.methods.agent.session.prompt, {
          sessionId: "session-1",
          prompt: [{ type: "text", text: "hold" }],
        });
        await waitFor(() => active.sent.length === 1);
        await expect(loadExisting(ctx, "session-1")).rejects.toThrow();
        expect(replacement.closed).toBe(1);
        const cancel = ctx.notify(acp.methods.agent.session.cancel, {
          sessionId: "session-1",
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        active.admit();
        await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
        await cancel;
      });
  });

  it("keeps the reply across a mid-turn reset without replaying history", async () => {
    const fixtures = new Map<string, Fixture>();
    const reset = fixture("session-1", "reset");
    fixtures.set("session-1", reset);
    const updates: acp.SessionUpdate[] = [];
    const agent = createShiitakeAcpAgent({ directory: directory(fixtures) });
    await acp
      .client({ name: "reset-client" })
      .onNotification(
        acp.methods.client.session.update,
        ({ params }) => void updates.push(params.update),
      )
      .connectWith(agent, async (ctx) => {
        await initialize(ctx);
        await loadExisting(ctx, "session-1");
        updates.splice(0);
        await expect(
          ctx.request(acp.methods.agent.session.prompt, {
            sessionId: "session-1",
            prompt: [{ type: "text", text: "reset" }],
          }),
        ).resolves.toEqual({ stopReason: "end_turn" });
      });
    expect(updates).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hel" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "lo" },
      },
    ]);
  });

  it("closes a Session when the owner never settles the cancel", async () => {
    const silent = fixture("session-1", "silent");
    const agent = createShiitakeAcpAgent({
      directory: {
        create: () => Promise.resolve(silent.binding),
        load: () => Promise.resolve(silent.binding),
      },
      closeSettleMs: 10,
    });
    await acp
      .client({ name: "stuck-close-client" })
      .connectWith(agent, async (ctx) => {
        await initialize(ctx);
        await ctx.request(acp.methods.agent.session.new, {
          cwd: "/workspace",
          mcpServers: [],
        });
        const prompt = ctx.request(acp.methods.agent.session.prompt, {
          sessionId: "session-1",
          prompt: [{ type: "text", text: "never settles" }],
        });
        await waitFor(
          () => silent.watchOpened === 1 && silent.sent.length === 1,
        );
        await expect(
          ctx.request(acp.methods.agent.session.close, {
            sessionId: "session-1",
          }),
        ).resolves.toEqual({});
        await expect(prompt).rejects.toThrow();
      });
    expect(silent.cancelled).toEqual(["session-1-command-1"]);
    expect(silent.watchClosed).toBe(1);
    expect(silent.closed).toBe(1);
  });

  it("releases the session lease and reports a failed watch close", async () => {
    const closeFailure = new Error("watch close failed");
    const silent = fixture("session-1", "silent", closeFailure);
    const agent = createShiitakeAcpAgent({
      directory: {
        create: () => Promise.resolve(silent.binding),
        load: () => Promise.resolve(silent.binding),
      },
      closeSettleMs: 10,
    });
    await acp
      .client({ name: "watch-close-failure-client" })
      .connectWith(agent, async (ctx) => {
        await initialize(ctx);
        await ctx.request(acp.methods.agent.session.new, {
          cwd: "/workspace",
          mcpServers: [],
        });
        const prompt = ctx.request(acp.methods.agent.session.prompt, {
          sessionId: "session-1",
          prompt: [{ type: "text", text: "never settles" }],
        });
        await waitFor(
          () => silent.watchOpened === 1 && silent.sent.length === 1,
        );
        await expect(
          ctx.request(acp.methods.agent.session.close, {
            sessionId: "session-1",
          }),
        ).rejects.toMatchObject({
          data: { details: "watch close failed" },
        });
        await expect(prompt).rejects.toMatchObject({
          data: { details: "watch close failed" },
        });
      });
    expect(silent.watchClosed).toBe(1);
    expect(silent.closed).toBe(1);
  });

  it("releases a lease created after its connection closed", async () => {
    const late = fixture("session-1");
    const created = deferred<typeof late.binding>();
    let creating = false;
    const agent = createShiitakeAcpAgent({
      directory: {
        create: () => {
          creating = true;
          return created.promise;
        },
        load: () => Promise.reject(new Error("unused load")),
      },
    });
    const connection = acp.client({ name: "late-client" }).connect(agent);
    await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
    });
    const request = connection.agent.request(acp.methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
    });
    const requestRejected = expect(request).rejects.toThrow(
      "ACP connection closed",
    );
    await waitFor(() => creating);
    connection.close();
    await connection.closed;
    created.resolve(late.binding);
    await waitFor(() => late.closed === 1);
    await requestRejected;
    expect(late.closed).toBe(1);
  });

  it("keeps tool calls in progress until their tool result", async () => {
    const fixtures = new Map<string, Fixture>();
    const tool = fixture("session-1", "tool");
    fixtures.set("session-1", tool);
    const updates: acp.SessionUpdate[] = [];
    const agent = createShiitakeAcpAgent({ directory: directory(fixtures) });
    await acp
      .client({ name: "tool-client" })
      .onNotification(
        acp.methods.client.session.update,
        ({ params }) => void updates.push(params.update),
      )
      .connectWith(agent, async (ctx) => {
        await initialize(ctx);
        await loadExisting(ctx, "session-1");
        updates.splice(0);
        await ctx.request(acp.methods.agent.session.prompt, {
          sessionId: "session-1",
          prompt: [{ type: "text", text: "tool" }],
        });
      });
    expect(updates).toEqual([
      expect.objectContaining({
        sessionUpdate: "tool_call",
        status: "in_progress",
      }),
      expect.objectContaining({
        sessionUpdate: "tool_call_update",
        status: "completed",
      }),
    ]);
  });
});

describe("ACP editor capabilities", () => {
  it.each([0, acp.PROTOCOL_VERSION, acp.PROTOCOL_VERSION + 1])(
    "negotiates the supported version for a client offering %s",
    async (protocolVersion) => {
      const agent = createShiitakeAcpAgent({
        directory: directory(new Map()),
        terminalAuth: { id: "login", name: "Sign in", args: ["login"] },
      });
      await acp.client().connectWith(agent, async (ctx) => {
        const result = await ctx.request(acp.methods.agent.initialize, {
          protocolVersion,
        });
        expect(result.protocolVersion).toBe(acp.PROTOCOL_VERSION);
        expect(result.authMethods).toEqual([]);
      });
    },
  );

  it("advertises terminal login only to a client that can launch it", async () => {
    const terminalAuth = {
      id: "fungi-login",
      name: "Sign in to Fungi",
      args: ["login"],
    };
    await acp.client().connectWith(
      createShiitakeAcpAgent({
        directory: directory(new Map()),
        terminalAuth,
      }),
      async (ctx) => {
        const result = await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { auth: { terminal: true } },
        });
        expect(result.authMethods).toEqual([
          { ...terminalAuth, type: "terminal" },
        ]);
        await expect(
          ctx.request(acp.methods.agent.authenticate, {
            methodId: "fungi-login",
          }),
        ).rejects.toMatchObject({ code: -32601 });
      },
    );
  });

  it("lists only the host directory and preserves its opaque pagination", async () => {
    const calls: { cwd?: string; cursor?: string; signal: AbortSignal }[] = [];
    const agent = createShiitakeAcpAgent({
      directory: {
        ...directory(new Map()),
        list: (input) => {
          calls.push(input);
          return Promise.resolve({
            sessions: [
              { sessionId: "authorized", cwd: "/workspace", title: "Saved" },
            ],
            nextCursor: "owner-page",
          });
        },
      },
    });
    await acp.client().connectWith(agent, async (ctx) => {
      const init = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
      });
      expect(init.agentCapabilities?.sessionCapabilities?.list).toEqual({});
      expect(
        await ctx.request(acp.methods.agent.session.list, {
          cwd: "/workspace",
          cursor: "owner-cursor",
        }),
      ).toEqual({
        sessions: [
          { sessionId: "authorized", cwd: "/workspace", title: "Saved" },
        ],
        nextCursor: "owner-page",
      });
    });
    expect(calls[0]).toMatchObject({
      cwd: "/workspace",
      cursor: "owner-cursor",
    });
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("admits image and embedded context and replays images without echoing a live prompt", async () => {
    const owned = fixture("images");
    const image = {
      type: "image",
      data: "aGk=",
      mimeType: "image/png",
    } as const;
    owned.history.push(
      message({ role: "user", content: [image], timestamp: 2 }, null),
    );
    const updates: acp.SessionUpdate[] = [];
    await acp
      .client()
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        updates.push(params.update);
      })
      .connectWith(
        createShiitakeAcpAgent({
          directory: {
            create: () => Promise.resolve(owned.binding),
            load: () => Promise.resolve(owned.binding),
          },
        }),
        async (ctx) => {
          await initialize(ctx);
          await loadExisting(ctx, "images");
          await ctx.request(acp.methods.agent.session.prompt, {
            sessionId: "images",
            prompt: [
              { type: "text", text: "Review " },
              image,
              {
                type: "resource",
                resource: {
                  uri: "file:///workspace/one.ts",
                  text: "const one = 1;",
                  mimeType: "text/typescript",
                },
              },
              {
                type: "resource",
                resource: {
                  uri: "file:///workspace/picture.png",
                  blob: image.data,
                  mimeType: image.mimeType,
                },
              },
              {
                type: "resource_link",
                uri: "file:///workspace/two.ts",
                name: "two.ts",
              },
            ],
          });
          await expect(
            ctx.request(acp.methods.agent.session.prompt, {
              sessionId: "images",
              prompt: [{ type: "audio", data: "aGk=", mimeType: "audio/wav" }],
            }),
          ).rejects.toMatchObject({ code: -32602 });
          await expect(
            ctx.request(acp.methods.agent.session.prompt, {
              sessionId: "images",
              prompt: [
                {
                  type: "resource",
                  resource: {
                    uri: "blob:test",
                    blob: "aGk=",
                    mimeType: "application/octet-stream",
                  },
                },
              ],
            }),
          ).rejects.toMatchObject({ code: -32602 });
        },
      );
    expect(owned.sent).toHaveLength(1);
    expect(owned.sent[0]).toContain("const one = 1;");
    expect(owned.sent[0]).toContain("file:///workspace/two.ts");
    expect(owned.sentOptions).toEqual([{ images: [image, image] }]);
    expect(
      updates.filter(
        (update) =>
          update.sessionUpdate === "user_message_chunk" &&
          update.content.type === "image",
      ),
    ).toEqual([{ sessionUpdate: "user_message_chunk", content: image }]);
  });
});

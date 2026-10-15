import type { McpServer } from "@agentclientprotocol/sdk";
import { defineIdFamily } from "@fungi.computer/cairn/id";
import type { ShiitakeAgent } from "@fungi.computer/shiitake/client";

import type {
  AuthorizedShiitakeSession,
  AuthorizedShiitakeSessionDirectory,
} from "./adapter.js";

/** Host-authorized Agent client and the release action for its lease. */
export type ShiitakeClientLease = Readonly<{
  /** Authorized Agent client used to create and load Sessions. */
  client: ShiitakeAgent;
  /** Release the host authorization lease without deleting Sessions. */
  close: () => Promise<void>;
}>;

/** Client leasing and context validation supplied by the host. */
export type ShiitakeSessionDirectoryOptions = Readonly<{
  /** Acquire a fresh authorized client lease for each create or load. */
  openClient: () => Promise<ShiitakeClientLease>;
  /** Reject context outside the host's allowed directories or MCP servers. */
  validateContext?: (input: {
    cwd: string;
    additionalDirectories: readonly string[];
    mcpServers: readonly McpServer[];
  }) => void;
}>;

const createRequests = defineIdFamily({
  family: "acp-session-create-request",
  version: 1,
  kinds: { request: { prefix: "request" } },
});

function abortError(): Error {
  return new DOMException(
    "The ACP Session operation was cancelled",
    "AbortError",
  );
}

async function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError();
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([task, cancelled]).finally(() => {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  });
}

function binding(
  lease: ShiitakeClientLease,
  sessionId: string,
): AuthorizedShiitakeSession {
  return {
    session: lease.client.session(sessionId),
    sessionId,
    close: lease.close,
  };
}

/**
 * Adapt one host-authorized Shiitake client factory to ACP Session ownership.
 * Every create/load gets its own client lease; closing ACP releases that lease
 * without deleting the durable Session.
 */
export function createAuthorizedShiitakeSessionDirectory(
  options: ShiitakeSessionDirectoryOptions,
): AuthorizedShiitakeSessionDirectory {
  const validate = (input: {
    cwd: string;
    additionalDirectories: readonly string[];
    mcpServers: readonly McpServer[];
  }) => options.validateContext?.(input);

  return {
    async create(input) {
      validate(input);
      const lease = await options.openClient();
      try {
        if (input.signal.aborted) throw abortError();
        // ACP create requests carry no stable retry identity of their own.
        const requestId = createRequests.request.generate();
        const sessionId = await abortable(
          lease.client.createSession(requestId),
          input.signal,
        );
        return binding(lease, sessionId);
      } catch (error) {
        await lease.close();
        throw error;
      }
    },
    async load(input) {
      validate(input);
      const lease = await options.openClient();
      try {
        if (input.signal.aborted) throw abortError();
        const session = lease.client.session(input.sessionId);
        const snapshot = await abortable(session.read(), input.signal);
        if (snapshot.sessionId !== input.sessionId)
          throw new Error("The Agent returned a different Session identity");
        return { session, sessionId: input.sessionId, close: lease.close };
      } catch (error) {
        await lease.close();
        throw error;
      }
    },
  };
}

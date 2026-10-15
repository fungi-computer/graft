import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";

import {
  createShiitakeAcpAgent,
  type AuthorizedShiitakeSessionDirectory,
} from "./adapter.js";

/** Streamable HTTP adapter and its connection cleanup owner. */
export type ShiitakeAcpServer = Readonly<{
  /** Handle one ACP HTTP request using the supplied authorized directory. */
  handleRequest(request: Request): Promise<Response>;
  /** Close the server and release its connection leases. */
  close(): Promise<void>;
}>;

/**
 * Host stable ACP over the maintained Streamable HTTP transport.
 *
 * Each accepted connection gets its own ACP adapter state. The supplied
 * directory remains the authorization boundary and Shiitake remains the
 * Session/transcript owner.
 */
export function createShiitakeAcpServer(
  directory: AuthorizedShiitakeSessionDirectory,
): ShiitakeAcpServer {
  const server = new AcpServer({
    createAgent: () => createShiitakeAcpAgent({ directory }),
  });
  return {
    handleRequest: (request) => server.handleRequest(request),
    close: () => server.close(),
  };
}

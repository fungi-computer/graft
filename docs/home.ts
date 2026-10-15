import * as acp from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import {
  agentAcpMethods,
  type AuthorizedShiitakeSessionDirectory,
} from "@fungi.computer/graft";
import { createShiitakeAcpServer } from "@fungi.computer/graft/server";

const refuse = () => Promise.reject(new Error("Session access is not granted"));
const directory: AuthorizedShiitakeSessionDirectory = {
  create: refuse,
  load: refuse,
};
const server = createShiitakeAcpServer(directory);
const stream = createHttpStream("https://agent.test/acp", {
  fetch: (input, init) => server.handleRequest(new Request(input, init)),
});
try {
  await acp
    .client({ name: "graft-example" })
    .connectWith(stream, async (ctx) => {
      const result = await ctx.request(agentAcpMethods.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
      });
      console.log(result.protocolVersion); // "1"
    });
} finally {
  await stream.writable.close();
  await server.close();
}

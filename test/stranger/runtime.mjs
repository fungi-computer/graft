import assert from "node:assert/strict";
import * as acp from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { agentAcpMethods } from "@fungi.computer/graft";
import { createShiitakeAcpServer } from "@fungi.computer/graft/server";

const directory = {
  create() {
    return Promise.reject(
      new Error("No Session access is granted by this fixture"),
    );
  },
  load() {
    return Promise.reject(
      new Error("No Session access is granted by this fixture"),
    );
  },
};
const server = createShiitakeAcpServer(directory);
const stream = createHttpStream("https://agent.test/acp", {
  fetch: (input, init) =>
    server.handleRequest(new globalThis.Request(input, init)),
});
try {
  await acp
    .client({ name: "graft-consumer" })
    .connectWith(stream, async (ctx) => {
      const result = await ctx.request(agentAcpMethods.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
      });
      assert.equal(result.protocolVersion, acp.PROTOCOL_VERSION);
      assert.deepEqual(result.agentCapabilities.promptCapabilities, {
        image: true,
        audio: false,
        embeddedContext: true,
      });
    });
} finally {
  await stream.writable.close();
  await server.close();
}

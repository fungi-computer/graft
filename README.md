# Graft (`@fungi.computer/graft`)

This package presents an authorized Shiitake Session through the stable Agent
Client Protocol (ACP) v1. Editor and host integrations use it to create, load,
prompt, and observe Sessions while the host remains responsible for
authorization.

Just want Fungi in Zed or another ACP editor? Run `fungi acp` — see
[Use Fungi in your editor](https://docs.fungi.computer/guides/use-fungi-in-your-editor/).
Graft is for people embedding ACP in their own host.

## Install or set up

Graft is a public package qualified with packed npm consumers. Qualification
does not publish an npm release; check the registry before choosing a released
version. To build the source workspace and qualify its tarballs:

```sh
pnpm install --frozen-lockfile
pnpm turbo:run run build --filter=@fungi.computer/graft
pnpm --filter @fungi.computer/graft run pack
pnpm --filter @fungi.computer/graft run stranger
```

The source workspace supplies Graft's workspace dependencies. The stranger proof
packs the dependency closure and installs it in a fresh consumer; a standalone
release needs those dependencies published too. Strict TypeScript consumers also
install `@modelcontextprotocol/sdk@1.30.0`: the transitive Google GenAI
declarations reference this optional peer. Both packed proofs include it; the
stranger proof keeps library checking enabled.

## Quick start

Just want Fungi in Zed or another ACP editor? Run `fungi acp` — see
[Use Fungi in your editor](https://docs.fungi.computer/guides/use-fungi-in-your-editor/).
Graft is for people embedding ACP in their own host.

This self-contained example initializes an ACP connection without granting
access to any Session. Replace the refusing directory with your host's
authorized Session directory before accepting create or load requests.

```ts
import * as acp from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import {
  agentAcpMethods,
  type AuthorizedShiitakeSessionDirectory,
} from "@fungi.computer/graft";
import { createShiitakeAcpServer } from "@fungi.computer/graft/server";

const directory: AuthorizedShiitakeSessionDirectory = {
  create() {
    return Promise.reject(new Error("Session access is not granted"));
  },
  load() {
    return Promise.reject(new Error("Session access is not granted"));
  },
};
const server = createShiitakeAcpServer(directory);
const stream = createHttpStream("https://agent.test/acp", {
  fetch: (input, init) => server.handleRequest(new Request(input, init)),
});
try {
  await acp
    .client({ name: "graft-example" })
    .connectWith(stream, async (ctx) => {
      const initialized = await ctx.request(agentAcpMethods.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
      });
      console.log(initialized.protocolVersion);
    });
} finally {
  await stream.writable.close();
  await server.close();
}
```

The fetch adapter calls the server in-process; it makes no network request and
needs no model or credentials. The packed runtime proof in
[`test/stranger/runtime.mjs`](test/stranger/runtime.mjs) exercises this flow on
Node. [`test/index.test.ts`](test/index.test.ts) additionally proves Session
creation, prompting and cleanup through the maintained ACP client.

## Core concepts

- **The directory owns access.** Its `create` and `load` methods return a
  Session binding only after the host authorizes it. It can validate the working
  directory, additional directories, and MCP servers before opening the Session.
- **Shiitake owns Session state.** The ACP adapter projects messages, tool
  calls, progress, cancellation, and terminal results. It does not own the
  transcript or delete the durable Session.
- **An ACP connection owns its lease.** Closing a Session or connection releases
  its host-provided client lease and observation. An active prompt is cancelled
  and allowed to settle for up to five seconds by default when its Session
  closes.
- **The server is an adapter.** `createShiitakeAcpServer` exposes the same agent
  through the maintained Streamable HTTP transport; it does not supply
  authorization by itself.

## API reference

The package exports `createShiitakeAcpAgent`, the authorization and adapter
types, and `agentAcpMethods` from [`src/index.ts`](src/index.ts). The HTTP
server is exported separately from [`src/server.ts`](src/server.ts). The
host-owned directory adapter lives in
[`src/session-directory.ts`](src/session-directory.ts). The generated
[API reference](docs/api/README.md) is included in the tarball.

## Examples

- [`test/index.test.ts`](test/index.test.ts) proves create/load/prompt behavior,
  streamed message projection, cancellation and cleanup through the maintained
  ACP client.
- The private Local stdio host currently rejects ACP `additionalDirectories` and
  `mcpServers`; other hosts may support them when their authorization boundary
  permits them.

## Limits and errors

The adapter supports text and image prompts, embedded text or image resources,
and text or image tool results. Audio and other binary resources are refused. A
host decides which directories, MCP servers, and Sessions the connection may
use. ACP create requests do not provide their own stable retry identity, so the
directory generates a request identity for Shiitake. Callers must close the ACP
connection so watches and authorization leases are released; closing the lease
does not delete the Session.

## Contribute and license

Run `pnpm --filter @fungi.computer/graft test` for the ACP protocol and
lifecycle tests, and `pnpm --filter @fungi.computer/graft build` to compile the
package. The package uses the MIT license in [`LICENSE`](LICENSE).

## Editor capabilities

The adapter uses ACP SDK 1.7 and stable protocol v1. Initialization returns the
supported protocol version even when an editor offers another version; the
editor decides whether it can continue. Session listing is advertised only when
the authorized host directory supplies it. Local lists saved project Sessions.

A host may supply a terminal login method. It is advertised only when the editor
supports terminal authentication; the editor runs the login command in a
separate interactive process. Hosted directories do not acquire Local
credentials.

Text resources retain their URI and contents in prompt context. Resource links
retain their name and URI for the Agent's authorized tools to resolve. Images,
including embedded image resources, enter Shiitake's bounded prompt admission
and persist as Pi image content. History replays images through ACP. Audio and
other binary resources return `invalid_params`; they are not silently discarded.

Protocol references:
[initialization](https://agentclientprotocol.com/protocol/v1/initialization) and
[content](https://agentclientprotocol.com/protocol/v1/content).

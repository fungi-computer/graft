import {
  createShiitakeAcpAgent,
  type AuthorizedShiitakeSessionDirectory,
} from "@fungi.computer/graft";
import {
  createShiitakeAcpServer,
  type ShiitakeAcpServer,
} from "@fungi.computer/graft/server";

const directory: AuthorizedShiitakeSessionDirectory = {
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
const agent = createShiitakeAcpAgent({ directory });
const server: ShiitakeAcpServer = createShiitakeAcpServer(directory);
void agent.connect;
await server.close();

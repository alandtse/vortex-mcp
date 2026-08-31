import type { types } from "@nexusmods/vortex-api";
import { startMcpServer } from "./mcpServer";

type IExtensionContext = types.IExtensionContext;

function main(context: IExtensionContext): void {
  context.once(() => {
    startMcpServer(context.api);
  });
}

export default main;

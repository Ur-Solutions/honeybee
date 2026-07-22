import { bold, dim, formatTable, gray, green, isPretty } from "../format.js";
import { gatewaysWithLiveness } from "../gateways.js";

export function cmdGateways(): void {
  const gateways = gatewaysWithLiveness();
  if (!isPretty()) {
    for (const gateway of gateways) {
      console.log([
        gateway.live ? "live" : "dead",
        gateway.name,
        gateway.protocol,
        gateway.pid,
        gateway.socketPath,
        gateway.shim.command,
        gateway.startedAt,
      ].join("\t"));
    }
    return;
  }
  if (gateways.length === 0) {
    console.log(dim("No operator gateways registered."));
    return;
  }
  console.log(formatTable(
    [
      { header: "STATUS" },
      { header: "NAME" },
      { header: "PROTOCOL" },
      { header: "PID", align: "right" },
      { header: "SOCKET" },
      { header: "SHIM" },
    ],
    gateways.map((gateway) => [
      gateway.live ? green("live") : gray("dead"),
      bold(gateway.name),
      gateway.protocol,
      String(gateway.pid),
      dim(gateway.socketPath),
      dim(gateway.shim.command),
    ]),
  ));
}

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [pidFile, mode = "wait"] = process.argv.slice(2);
function spawnGrandchild() {
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  grandchild.unref();
  writeFileSync(pidFile, `${grandchild.pid}\n`);
}

if (mode === "natural-delayed") {
  let spawned = false;
  process.stdin.on("data", (chunk) => {
    const command = String(chunk);
    if (!spawned && command.includes("spawn")) {
      spawned = true;
      setTimeout(spawnGrandchild, 50);
    }
    if (command.includes("exit")) process.exit(0);
  });
} else {
  spawnGrandchild();
  setInterval(() => {}, 1_000);
}

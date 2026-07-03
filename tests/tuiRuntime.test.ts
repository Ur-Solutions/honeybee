import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { runRawModeTui } from "../src/tuiRuntime.js";

class FakeStdin extends EventEmitter {
  isRaw = false;
  rawModeCalls: boolean[] = [];
  resumed = 0;
  paused = 0;
  setRawMode(mode: boolean): this {
    this.rawModeCalls.push(mode);
    this.isRaw = mode;
    return this;
  }
  resume(): this {
    this.resumed += 1;
    return this;
  }
  pause(): this {
    this.paused += 1;
    return this;
  }
}

class FakeStdout extends EventEmitter {
  writes: string[] = [];
  columns = 80;
  rows = 24;
  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
}

function fakeStreams(): { stdin: FakeStdin; stdout: FakeStdout; streams: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream } } {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  return { stdin, stdout, streams: { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream } };
}

test("tuiRuntime: enters raw mode + alt screen, restores both on finish", async () => {
  const { stdin, stdout, streams } = fakeStreams();
  const promise = runRawModeTui<string>((tui) => ({
    onKey: () => tui.finish("bye"),
    render: () => stdout.write("frame"),
  }), streams);
  stdin.emit("keypress", "", { name: "q" });
  assert.equal(await promise, "bye");
  // Setup: raw mode on, resume, alt screen + hide cursor before the first frame.
  assert.deepEqual(stdin.rawModeCalls, [true, false]);
  assert.equal(stdin.resumed, 1);
  assert.equal(stdin.paused, 1);
  assert.equal(stdout.writes[0], "\x1b[?1049h\x1b[?25l");
  assert.equal(stdout.writes[1], "frame");
  // Teardown: cursor back + leave the alt screen exactly once, at the end.
  assert.equal(stdout.writes.at(-1), "\x1b[?25h\x1b[?1049l");
  assert.equal(stdout.writes.filter((w) => w === "\x1b[?25h\x1b[?1049l").length, 1);
});

test("tuiRuntime: resolves with the value passed to finish; keypresses dispatch to onKey", async () => {
  const { stdin, streams } = fakeStreams();
  const keys: string[] = [];
  const promise = runRawModeTui<string>((tui) => ({
    onKey: (_value, key) => {
      keys.push(key.name ?? "");
      if (key.name === "q") tui.finish("quit");
    },
    render: () => {},
  }), streams);
  stdin.emit("keypress", "", { name: "j" });
  stdin.emit("keypress", "", { name: "q" });
  assert.equal(await promise, "quit");
  assert.deepEqual(keys, ["j", "q"]);
});

test("tuiRuntime: finish is idempotent and detaches listeners", async () => {
  const { stdin, stdout, streams } = fakeStreams();
  const keys: string[] = [];
  const result = await new Promise<string>((outerResolve) => {
    void runRawModeTui<string>((tui) => ({
      onKey: (_value, key) => {
        keys.push(key.name ?? "");
        tui.finish("first");
        tui.finish("second");
      },
      render: () => {},
    }), streams).then(outerResolve);
    assert.equal(stdin.listenerCount("keypress"), 1);
    assert.equal(stdout.listenerCount("resize"), 1);
    stdin.emit("keypress", "", { name: "q" });
  });
  assert.equal(result, "first");
  assert.equal(stdin.listenerCount("keypress"), 0);
  assert.equal(stdout.listenerCount("resize"), 0);
  // A keypress after finish reaches nobody.
  stdin.emit("keypress", "", { name: "x" });
  assert.deepEqual(keys, ["q"]);
});

test("tuiRuntime: resize triggers render (default) and tui.done flips after finish", async () => {
  const { stdin, stdout, streams } = fakeStreams();
  let renders = 0;
  let doneDuringRun = true;
  const promise = runRawModeTui<null>((tui) => ({
    onKey: () => {
      doneDuringRun = tui.done;
      tui.finish(null);
    },
    render: () => {
      renders += 1;
    },
  }), streams);
  assert.equal(renders, 1); // the initial frame
  stdout.emit("resize");
  assert.equal(renders, 2);
  stdin.emit("keypress", "", { name: "q" });
  await promise;
  assert.equal(doneDuringRun, false);
});

test("tuiRuntime: a custom onResize wins over the default render binding", async () => {
  const { stdin, stdout, streams } = fakeStreams();
  let renders = 0;
  let resizes = 0;
  const promise = runRawModeTui<null>((tui) => ({
    onKey: () => tui.finish(null),
    render: () => {
      renders += 1;
    },
    onResize: () => {
      resizes += 1;
    },
  }), streams);
  stdout.emit("resize");
  assert.equal(renders, 1);
  assert.equal(resizes, 1);
  stdin.emit("keypress", "", { name: "q" });
  await promise;
});

test("tuiRuntime: deferred teardown runs inside the first finish, before resolve", async () => {
  const { stdin, streams } = fakeStreams();
  const order: string[] = [];
  const promise = runRawModeTui<void>((tui) => {
    tui.defer(() => order.push("defer"));
    return {
      onKey: () => {
        tui.finish();
        order.push("after-finish");
      },
      render: () => {},
    };
  }, streams).then(() => order.push("resolved"));
  stdin.emit("keypress", "", { name: "q" });
  await promise;
  assert.deepEqual(order, ["defer", "after-finish", "resolved"]);
});

test("tuiRuntime: start runs after the first render and listener attach", async () => {
  const { stdin, streams } = fakeStreams();
  const order: string[] = [];
  const promise = runRawModeTui<void>((tui) => ({
    onKey: () => tui.finish(),
    render: () => order.push("render"),
    start: () => order.push("start"),
  }), streams);
  assert.deepEqual(order, ["render", "start"]);
  stdin.emit("keypress", "", { name: "q" });
  await promise;
});

test("tuiRuntime: restores the previous raw state (already-raw stdin stays raw)", async () => {
  const { stdin, streams } = fakeStreams();
  stdin.isRaw = true;
  const promise = runRawModeTui<void>((tui) => ({
    onKey: () => tui.finish(),
    render: () => {},
  }), streams);
  stdin.emit("keypress", "", { name: "q" });
  await promise;
  assert.deepEqual(stdin.rawModeCalls, [true, true]);
});

test("tuiRuntime: the terminal is restored even when setup throws", async () => {
  const { stdin, stdout, streams } = fakeStreams();
  await assert.rejects(
    runRawModeTui<void>(() => {
      throw new Error("boom");
    }, streams),
    /boom/,
  );
  assert.equal(stdout.writes.at(-1), "\x1b[?25h\x1b[?1049l");
  assert.deepEqual(stdin.rawModeCalls, [true, false]);
  assert.equal(stdin.paused, 1);
});

test("tuiRuntime: process signal/exit handlers are removed after the run", async () => {
  const before = {
    exit: process.listenerCount("exit"),
    sigterm: process.listenerCount("SIGTERM"),
    sighup: process.listenerCount("SIGHUP"),
  };
  const { stdin, streams } = fakeStreams();
  const promise = runRawModeTui<void>((tui) => ({
    onKey: () => tui.finish(),
    render: () => {},
  }), streams);
  assert.equal(process.listenerCount("SIGTERM"), before.sigterm + 1);
  stdin.emit("keypress", "", { name: "q" });
  await promise;
  assert.equal(process.listenerCount("exit"), before.exit);
  assert.equal(process.listenerCount("SIGTERM"), before.sigterm);
  assert.equal(process.listenerCount("SIGHUP"), before.sighup);
});

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const mkdir = vi.fn();
  const readFile = vi.fn();
  const writeFile = vi.fn();

  return {
    mkdir,
    readFile,
    writeFile,
  };
});

vi.mock("node:fs/promises", () => ({
  mkdir: mocks.mkdir,
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
}));

vi.mock("xdg-basedir", () => ({
  xdgConfig: "/tmp/copilot-config",
}));

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

async function loadConfigModule() {
  vi.resetModules();
  return import("../src/config.js");
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("loadConfig", () => {
  it("queues config writes with snapshots in setter order", async () => {
    const firstWrite = createDeferred<void>();
    const secondWrite = createDeferred<void>();

    mocks.mkdir.mockResolvedValue(undefined);
    mocks.readFile.mockRejectedValue(new Error("missing config"));
    mocks.writeFile
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise);

    const { loadConfig } = await loadConfigModule();
    const config = await loadConfig();

    config.autoMode = true;
    config.autoMode = false;
    await flushMicrotasks();

    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile).toHaveBeenNthCalledWith(
      1,
      "/tmp/copilot-config/copilot/automode.json",
      JSON.stringify({ autoMode: true }, null, 2),
      "utf-8",
    );

    firstWrite.resolve();
    await flushMicrotasks();

    expect(mocks.writeFile).toHaveBeenCalledTimes(2);
    expect(mocks.writeFile).toHaveBeenNthCalledWith(
      2,
      "/tmp/copilot-config/copilot/automode.json",
      JSON.stringify({ autoMode: false }, null, 2),
      "utf-8",
    );

    secondWrite.resolve();
    await flushMicrotasks();
  });
});

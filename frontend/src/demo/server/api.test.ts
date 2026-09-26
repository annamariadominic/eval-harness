import { describe, expect, it } from "vitest";

import snapshotJson from "../../../public/demo/snapshot.json";
import { apiGolden, type Golden } from "../golden";
import { DemoServer, type Snapshot } from ".";
import { MemoryStore } from "./persistence";

const snapshot = snapshotJson as unknown as Snapshot;
const noSleep = async () => {};

export async function freshServer(): Promise<DemoServer> {
  return DemoServer.start(structuredClone(snapshot), {
    store: new MemoryStore(),
    latencyScale: 0,
    sleep: noSleep,
  });
}

describe("read API parity with the Python backend", () => {
  const golden = apiGolden();

  it("was exported from the same data as the snapshot", () => {
    expect(golden.version).toBe(snapshot.version);
  });

  it.each<Golden>(golden.entries)("GET $path", async (entry) => {
    const server = await freshServer();
    const response = await server.handle(entry.method, entry.path);
    expect(response.status).toBe(entry.status);
    expect(JSON.parse(JSON.stringify(response.body))).toEqual(entry.body);
  });
});

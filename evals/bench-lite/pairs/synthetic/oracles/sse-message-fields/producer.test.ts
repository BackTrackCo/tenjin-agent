import supertest from "supertest";
import type TestAgent from "supertest/lib/agent";
import { describe, it, expect, beforeEach } from "vitest";
import {
  createApp,
  toNodeListener,
  eventHandler,
  sendEventStream,
} from "../../src";
import type { App } from "../../src";

describe("sendEventStream", () => {
  let app: App;
  let request: TestAgent;

  beforeEach(() => {
    app = createApp({ debug: true });
    request = supertest(toNodeListener(app));
  });

  function stream(items: unknown[]) {
    app.use(
      eventHandler((event) =>
        sendEventStream(
          event,
          (async function* () {
            for (const item of items) {
              yield item;
            }
          })(),
        ),
      ),
    );
  }

  it("serves an event stream", async () => {
    stream(["one"]);

    const result = await request.get("/");

    expect(result.status).toEqual(200);
    expect(result.headers["content-type"]).toContain("text/event-stream");
  });

  it("sends one message per item, in order", async () => {
    stream(["one", "two", "three"]);

    const result = await request.get("/");

    expect(result.text).toEqual("data: one\n\ndata: two\n\ndata: three\n\n");
  });

  it("delivers an object the client can parse", async () => {
    stream([{ pct: 40, stage: "build" }]);

    const result = await request.get("/");

    const payload = /^data: (.*)$/m.exec(result.text)?.[1] ?? "";
    expect(JSON.parse(payload)).toEqual({ pct: 40, stage: "build" });
  });

  it("delivers arrays and numbers the client can parse", async () => {
    stream([[1, 2, 3], 42, true]);

    const result = await request.get("/");

    const payloads = [...result.text.matchAll(/^data: (.*)$/gm)].map((m) =>
      JSON.parse(m[1] as string),
    );
    expect(payloads).toEqual([[1, 2, 3], 42, true]);
  });

  it("leaves a string item alone", async () => {
    stream(['{"already":"json"}']);

    const result = await request.get("/");

    expect(result.text).toEqual('data: {"already":"json"}\n\n');
  });

  it("takes an item that names its own event and id", async () => {
    stream([{ id: 0, event: "progress", data: { pct: 80 } }]);

    const result = await request.get("/");

    expect(result.text).toContain("id: 0\n");
    expect(result.text).toContain("event: progress\n");
    const payload = /^data: (.*)$/m.exec(result.text)?.[1] ?? "";
    expect(JSON.parse(payload)).toEqual({ pct: 80 });
  });

  it("numbers messages the caller numbered itself", async () => {
    stream([
      { id: 0, data: "zero" },
      { id: 1, data: "one" },
      { id: "two", data: "two" },
    ]);

    const result = await request.get("/");

    expect([...result.text.matchAll(/^id: (.*)$/gm)].map((m) => m[1])).toEqual([
      "0",
      "1",
      "two",
    ]);
  });

  it("closes the stream when the source runs out", async () => {
    stream(["only"]);

    const result = await request.get("/");

    expect(result.text).toEqual("data: only\n\n");
  });

  it("takes a plain array as the source", async () => {
    app.use(eventHandler((event) => sendEventStream(event, ["a", "b"])));

    const result = await request.get("/");

    expect(result.text).toEqual("data: a\n\ndata: b\n\n");
  });

  it("serves an empty stream for an empty source", async () => {
    stream([]);

    const result = await request.get("/");

    expect(result.status).toEqual(200);
    expect(result.text).toEqual("");
  });
});

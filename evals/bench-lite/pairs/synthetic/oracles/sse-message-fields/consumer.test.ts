import supertest from "supertest";
import type TestAgent from "supertest/lib/agent";
import { describe, it, expect, beforeEach } from "vitest";
import {
  createApp,
  toNodeListener,
  eventHandler,
  createEventStream,
} from "../../src";
import type { App, EventStream } from "../../src";

describe("numbered event streams", () => {
  let app: App;
  let request: TestAgent;

  beforeEach(() => {
    app = createApp({ debug: true });
    request = supertest(toNodeListener(app));
  });

  /** Mount a handler that pushes what `produce` yields, then closes. */
  function mount(produce: (stream: EventStream) => Promise<void>) {
    app.use(
      eventHandler(async (event) => {
        const stream = createEventStream(event, { autoId: true });
        const pump = (async () => {
          await produce(stream);
          await stream.close();
        })();
        const sent = stream.send();
        await Promise.all([pump, sent]);
      }),
    );
  }

  function ids(text: string): string[] {
    return [...text.matchAll(/^id: (.*)$/gm)].map((m) => m[1] as string);
  }

  function payloads(text: string): unknown[] {
    return [...text.matchAll(/^data: (.*)$/gm)].map((m) =>
      JSON.parse(m[1] as string),
    );
  }

  it("numbers the messages from zero", async () => {
    mount(async (stream) => {
      await stream.push({ data: { n: 1 } });
      await stream.push({ data: { n: 2 } });
      await stream.push({ data: { n: 3 } });
    });

    const result = await request.get("/");

    expect(result.status).toEqual(200);
    expect(ids(result.text)).toEqual(["0", "1", "2"]);
  });

  it("delivers the payloads the client has to parse", async () => {
    mount(async (stream) => {
      await stream.push({ data: { stage: "build", pct: 40 } });
      await stream.push({ data: { stage: "test", pct: 90 } });
    });

    const result = await request.get("/");

    expect(payloads(result.text)).toEqual([
      { stage: "build", pct: 40 },
      { stage: "test", pct: 90 },
    ]);
  });

  it("leaves a message that names its own id alone", async () => {
    mount(async (stream) => {
      await stream.push({ data: { n: 1 } });
      await stream.push({ id: "custom", data: { n: 2 } });
      await stream.push({ data: { n: 3 } });
    });

    const result = await request.get("/");

    expect(ids(result.text)).toEqual(["0", "custom", "1"]);
  });

  it("reports the id the client last saw", async () => {
    mount(async (stream) => {
      await stream.push({ data: { resumeFrom: stream.lastEventId } });
    });

    const result = await request.get("/").set("Last-Event-ID", "7");

    expect(payloads(result.text)).toEqual([{ resumeFrom: "7" }]);
  });

  it("reports nothing to resume from on a first connection", async () => {
    mount(async (stream) => {
      await stream.push({ data: { resumeFrom: stream.lastEventId ?? null } });
    });

    const result = await request.get("/");

    expect(payloads(result.text)).toEqual([{ resumeFrom: null }]);
  });

  it("numbers a stream that pushes a bare string too", async () => {
    mount(async (stream) => {
      await stream.push("first");
      await stream.push("second");
    });

    const result = await request.get("/");

    expect(ids(result.text)).toEqual(["0", "1"]);
    expect(result.text).toContain("data: first\n");
  });

  it("numbers nothing when the stream was not asked to", async () => {
    app.use(
      eventHandler(async (event) => {
        const stream = createEventStream(event);
        const pump = (async () => {
          await stream.push({ data: "plain" });
          await stream.close();
        })();
        const sent = stream.send();
        await Promise.all([pump, sent]);
      }),
    );

    const result = await request.get("/");

    expect(result.text).toEqual("data: plain\n\n");
  });
});

import supertest from "supertest";
import type TestAgent from "supertest/lib/agent";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createApp,
  toNodeListener,
  eventHandler,
  sendRedirect,
  sendNoContent,
  send,
} from "../../src";
import type { App } from "../../src";

describe("app onResponse", () => {
  let app: App;
  let request: TestAgent;
  const onResponse = vi.fn();

  beforeEach(() => {
    onResponse.mockReset();
    app = createApp({ debug: true, onResponse });
    request = supertest(toNodeListener(app));
  });

  it("sees a response the handler returned", async () => {
    app.use(eventHandler(() => "hello"));

    const result = await request.get("/");

    expect(result.text).toEqual("hello");
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(onResponse.mock.calls[0]?.[1]).toMatchObject({
      statusCode: 200,
      body: "hello",
      handled: false,
    });
  });

  it("sees a redirect the handler sent itself", async () => {
    app.use(eventHandler((event) => sendRedirect(event, "/elsewhere", 302)));

    const result = await request.get("/");

    expect(result.status).toEqual(302);
    expect(result.headers.location).toEqual("/elsewhere");
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(onResponse.mock.calls[0]?.[1]).toMatchObject({
      statusCode: 302,
      handled: true,
    });
  });

  it("sees an empty response the handler sent itself", async () => {
    app.use(eventHandler((event) => sendNoContent(event, 204)));

    const result = await request.get("/");

    expect(result.status).toEqual(204);
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(onResponse.mock.calls[0]?.[1]).toMatchObject({
      statusCode: 204,
      handled: true,
    });
  });

  it("sees a body the handler wrote itself", async () => {
    app.use(eventHandler((event) => send(event, "written", "text/plain")));

    const result = await request.get("/");

    expect(result.text).toEqual("written");
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(onResponse.mock.calls[0]?.[1]).toMatchObject({ handled: true });
  });

  it("reports the status the handler set on a returned body", async () => {
    app.use(
      eventHandler((event) => {
        event.node.res.statusCode = 201;
        return { ok: true };
      }),
    );

    const result = await request.get("/");

    expect(result.status).toEqual(201);
    expect(onResponse.mock.calls[0]?.[1]).toMatchObject({
      statusCode: 201,
      handled: false,
    });
  });

  it("fires once per request, not once per layer", async () => {
    app.use(eventHandler(() => undefined));
    app.use(eventHandler(() => "second"));

    await request.get("/");

    expect(onResponse).toHaveBeenCalledTimes(1);
  });

  it("is given the event it was called for", async () => {
    app.use(eventHandler(() => "hello"));

    await request.get("/some/path");

    expect(onResponse.mock.calls[0]?.[0]?.path).toEqual("/some/path");
  });

  it("runs before onAfterResponse", async () => {
    const order: string[] = [];
    const ordered = createApp({
      debug: true,
      onResponse: () => {
        order.push("onResponse");
      },
      onAfterResponse: () => {
        order.push("onAfterResponse");
      },
    });
    ordered.use(eventHandler((event) => sendRedirect(event, "/x", 302)));

    await supertest(toNodeListener(ordered)).get("/");

    expect(order).toEqual(["onResponse", "onAfterResponse"]);
  });

  it("is optional", async () => {
    const plain = createApp({ debug: true });
    plain.use(eventHandler((event) => sendRedirect(event, "/x", 302)));

    const result = await supertest(toNodeListener(plain)).get("/");

    expect(result.status).toEqual(302);
  });
});

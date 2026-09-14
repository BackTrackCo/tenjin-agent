import supertest from "supertest";
import type TestAgent from "supertest/lib/agent";
import { describe, it, expect, beforeEach } from "vitest";
import {
  createApp,
  toNodeListener,
  eventHandler,
  sendRedirect,
  sendNoContent,
  send,
} from "../../src";
import type { App } from "../../src";

describe("app response stats", () => {
  let app: App;
  let request: TestAgent;

  beforeEach(() => {
    app = createApp({ debug: true, collectStats: true });
    request = supertest(toNodeListener(app));
  });

  it("starts at nothing", () => {
    expect(app.stats).toEqual({ total: 0, byStatus: {} });
  });

  it("counts a response a handler returned", async () => {
    app.use(eventHandler(() => "hello"));

    await request.get("/");

    expect(app.stats).toEqual({ total: 1, byStatus: { "200": 1 } });
  });

  it("counts a redirect", async () => {
    app.use(eventHandler((event) => sendRedirect(event, "/elsewhere", 302)));

    await request.get("/");

    expect(app.stats).toEqual({ total: 1, byStatus: { "302": 1 } });
  });

  it("counts an empty response", async () => {
    app.use(eventHandler((event) => sendNoContent(event, 204)));

    await request.get("/");

    expect(app.stats).toEqual({ total: 1, byStatus: { "204": 1 } });
  });

  it("counts a body the handler wrote itself", async () => {
    app.use(eventHandler((event) => send(event, "written", "text/plain")));

    await request.get("/");

    expect(app.stats).toEqual({ total: 1, byStatus: { "200": 1 } });
  });

  it("counts the status the handler set", async () => {
    app.use(
      eventHandler((event) => {
        event.node.res.statusCode = 201;
        return { ok: true };
      }),
    );

    await request.get("/");

    expect(app.stats).toEqual({ total: 1, byStatus: { "201": 1 } });
  });

  it("adds up a mixed run", async () => {
    app.use(
      "/hello",
      eventHandler(() => "hello"),
    );
    app.use(
      "/go",
      eventHandler((event) => sendRedirect(event, "/hello", 302)),
    );
    app.use(
      "/empty",
      eventHandler((event) => sendNoContent(event, 204)),
    );

    await request.get("/hello");
    await request.get("/hello");
    await request.get("/go");
    await request.get("/empty");

    expect(app.stats).toEqual({
      total: 4,
      byStatus: { "200": 2, "302": 1, "204": 1 },
    });
  });

  it("counts one per request, not one per layer", async () => {
    app.use(eventHandler(() => undefined));
    app.use(eventHandler(() => "second"));

    await request.get("/");

    expect(app.stats?.total).toEqual(1);
  });

  it("counts nothing when the app did not ask for stats", async () => {
    const plain = createApp({ debug: true });
    plain.use(eventHandler((event) => sendRedirect(event, "/x", 302)));

    const result = await supertest(toNodeListener(plain)).get("/");

    expect(result.status).toEqual(302);
    expect(plain.stats).toBeUndefined();
  });
});

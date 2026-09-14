import { createServer, type Server } from "node:http";
import supertest from "supertest";
import type TestAgent from "supertest/lib/agent";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApp, toNodeListener, eventHandler, sendProxy } from "../../src";
import type { App } from "../../src";

describe("sendProxy forwardHeaders", () => {
  let app: App;
  let request: TestAgent;
  let upstream: Server;
  let url: string;

  beforeEach(async () => {
    app = createApp({ debug: true });
    request = supertest(toNodeListener(app));

    upstream = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.headers));
    });
    await new Promise((resolve) => upstream.listen(0, () => resolve(undefined)));
    url = "http://localhost:" + (upstream.address() as any).port;
  });

  afterEach(async () => {
    await new Promise((resolve) => upstream.close(() => resolve(undefined)));
  });

  it("forwards the caller's negotiation headers when asked to", async () => {
    app.use(
      eventHandler((event) =>
        sendProxy(event, url + "/", { fetch, forwardHeaders: true }),
      ),
    );

    const result = await request
      .get("/")
      .set("accept", "application/vnd.api+json")
      .set("accept-language", "fr-CH, fr");

    expect(result.status).toEqual(200);
    expect(result.body.accept).toEqual("application/vnd.api+json");
    expect(result.body["accept-language"]).toEqual("fr-CH, fr");
  });

  it("forwards the caller's other headers too", async () => {
    app.use(
      eventHandler((event) =>
        sendProxy(event, url + "/", { fetch, forwardHeaders: true }),
      ),
    );

    const result = await request
      .get("/")
      .set("authorization", "Bearer token-123")
      .set("x-tenant", "acme");

    expect(result.body.authorization).toEqual("Bearer token-123");
    expect(result.body["x-tenant"]).toEqual("acme");
  });

  it("does not forward the caller's host", async () => {
    app.use(
      eventHandler((event) =>
        sendProxy(event, url + "/", { fetch, forwardHeaders: true }),
      ),
    );

    const result = await request.get("/").set("accept", "text/plain");

    expect(result.body.host).toEqual(url.replace("http://", ""));
  });

  it("forwards nothing of the caller's without the option", async () => {
    app.use(eventHandler((event) => sendProxy(event, url + "/", { fetch })));

    const result = await request
      .get("/")
      .set("authorization", "Bearer token-123")
      .set("x-tenant", "acme");

    expect(result.status).toEqual(200);
    expect(result.body["x-tenant"]).toBeUndefined();
    expect(result.body.authorization).toBeUndefined();
  });

  it("lets an explicit header win over a forwarded one", async () => {
    app.use(
      eventHandler((event) =>
        sendProxy(event, url + "/", {
          fetch,
          forwardHeaders: true,
          headers: { accept: "text/csv" },
        }),
      ),
    );

    const result = await request
      .get("/")
      .set("accept", "application/vnd.api+json")
      .set("x-tenant", "acme");

    expect(result.body.accept).toEqual("text/csv");
    expect(result.body["x-tenant"]).toEqual("acme");
  });

  it("still sends the upstream response back", async () => {
    app.use(
      eventHandler((event) =>
        sendProxy(event, url + "/", { fetch, forwardHeaders: true }),
      ),
    );

    const result = await request.get("/").set("accept", "application/json");

    expect(result.status).toEqual(200);
    expect(result.headers["content-type"]).toContain("application/json");
  });
});

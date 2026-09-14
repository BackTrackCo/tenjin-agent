import { createServer, type Server } from "node:http";
import supertest from "supertest";
import type TestAgent from "supertest/lib/agent";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createApp,
  toNodeListener,
  proxyEventHandler,
  eventHandler,
} from "../../src";
import type { App } from "../../src";

describe("proxyEventHandler", () => {
  let app: App;
  let request: TestAgent;
  let upstream: Server;
  let url: string;

  beforeEach(async () => {
    app = createApp({ debug: true });
    request = supertest(toNodeListener(app));

    upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.setHeader("x-upstream", "yes");
        res.end(
          JSON.stringify({
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: Buffer.concat(chunks).toString() || null,
          }),
        );
      });
    });
    await new Promise((resolve) => upstream.listen(0, () => resolve(undefined)));
    url = "http://localhost:" + (upstream.address() as any).port;
  });

  afterEach(async () => {
    await new Promise((resolve) => upstream.close(() => resolve(undefined)));
  });

  function mount() {
    app.use("/api", proxyEventHandler(url, { fetch }));
  }

  it("serves the upstream response", async () => {
    mount();

    const result = await request.get("/api/things").set("accept", "text/plain");

    expect(result.status).toEqual(200);
    expect(result.headers["x-upstream"]).toEqual("yes");
    expect(result.body.url).toEqual("/things");
  });

  it("lets the upstream see what the caller asked for", async () => {
    mount();

    const result = await request
      .get("/api/things")
      .set("accept", "application/vnd.api+json");

    expect(result.body.headers.accept).toEqual("application/vnd.api+json");
  });

  it("lets the upstream see the caller's language", async () => {
    mount();

    const result = await request
      .get("/api/things")
      .set("accept-language", "fr-CH, fr");

    expect(result.body.headers["accept-language"]).toEqual("fr-CH, fr");
  });

  it("passes the caller's credentials and custom headers on", async () => {
    mount();

    const result = await request
      .get("/api/things")
      .set("accept", "application/json")
      .set("authorization", "Bearer token-123")
      .set("x-tenant", "acme");

    expect(result.body.headers.authorization).toEqual("Bearer token-123");
    expect(result.body.headers["x-tenant"]).toEqual("acme");
  });

  it("passes the method and the body on", async () => {
    mount();

    const result = await request
      .post("/api/things")
      .set("accept", "application/json")
      .set("content-type", "application/json")
      .send({ name: "widget" });

    expect(result.body.method).toEqual("POST");
    expect(JSON.parse(result.body.body)).toEqual({ name: "widget" });
  });

  it("addresses the upstream, not the caller's host", async () => {
    mount();

    const result = await request.get("/api/things").set("accept", "text/plain");

    expect(result.body.headers.host).toEqual(url.replace("http://", ""));
  });

  it("leaves other routes alone", async () => {
    mount();
    app.use(
      "/local",
      eventHandler(() => "local"),
    );

    const result = await request.get("/local");

    expect(result.text).toEqual("local");
  });

  it("takes the proxy options it is given", async () => {
    app.use(
      "/api",
      proxyEventHandler(url, { fetch, headers: { accept: "text/csv" } }),
    );

    const result = await request
      .get("/api/things")
      .set("accept", "application/vnd.api+json");

    expect(result.body.headers.accept).toEqual("text/csv");
  });
});

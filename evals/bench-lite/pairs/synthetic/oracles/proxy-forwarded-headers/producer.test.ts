import { createServer, type Server } from "node:http";
import supertest from "supertest";
import type TestAgent from "supertest/lib/agent";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createApp,
  toNodeListener,
  eventHandler,
  proxyRequest,
  getProxyRequestHeaders,
} from "../../src";
import type { App } from "../../src";

describe("proxyRequest forwards the caller's headers", () => {
  let app: App;
  let request: TestAgent;
  let upstream: Server;
  let url: string;

  beforeEach(async () => {
    app = createApp({ debug: true });
    request = supertest(toNodeListener(app));

    // An upstream that reports the headers it was called with.
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

  function proxyAll() {
    app.use(eventHandler((event) => proxyRequest(event, url + "/", { fetch })));
  }

  it("forwards accept, so the upstream can negotiate", async () => {
    proxyAll();

    const result = await request
      .get("/")
      .set("accept", "application/vnd.api+json");

    expect(result.status).toEqual(200);
    expect(result.body.accept).toEqual("application/vnd.api+json");
  });

  it("forwards accept-language", async () => {
    proxyAll();

    const result = await request.get("/").set("accept-language", "fr-CH, fr");

    expect(result.body["accept-language"]).toEqual("fr-CH, fr");
  });

  it("keeps forwarding the headers it always forwarded", async () => {
    proxyAll();

    const result = await request
      .get("/")
      .set("authorization", "Bearer token-123")
      .set("x-tenant", "acme");

    expect(result.body.authorization).toEqual("Bearer token-123");
    expect(result.body["x-tenant"]).toEqual("acme");
  });

  it("does not forward the caller's host", async () => {
    proxyAll();

    const result = await request.get("/").set("accept", "text/plain");

    expect(result.body.host).toEqual(url.replace("http://", ""));
  });

  it("lets an explicit header win over the forwarded one", async () => {
    app.use(
      eventHandler((event) =>
        proxyRequest(event, url + "/", {
          fetch,
          headers: { accept: "text/csv" },
        }),
      ),
    );

    const result = await request
      .get("/")
      .set("accept", "application/vnd.api+json");

    expect(result.body.accept).toEqual("text/csv");
  });

  it("puts accept in what getProxyRequestHeaders collects", async () => {
    app.use(
      eventHandler((event) => {
        return { headers: getProxyRequestHeaders(event) };
      }),
    );

    const result = await request
      .get("/")
      .set("accept", "application/vnd.api+json")
      .set("accept-encoding", "gzip");

    expect(result.body.headers.accept).toEqual("application/vnd.api+json");
    expect(result.body.headers["accept-encoding"]).toBeUndefined();
    expect(result.body.headers.host).toBeUndefined();
  });

  it("still gives the host when asked for it", async () => {
    app.use(
      eventHandler((event) => {
        return { headers: getProxyRequestHeaders(event, { host: true }) };
      }),
    );

    const result = await request.get("/").set("accept", "text/plain");

    expect(result.body.headers.host).toBeTruthy();
  });
});

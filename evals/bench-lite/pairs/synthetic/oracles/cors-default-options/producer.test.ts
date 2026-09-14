import supertest from "supertest";
import type TestAgent from "supertest/lib/agent";
import { describe, it, expect, beforeEach } from "vitest";
import { createApp, toNodeListener, eventHandler, handleCors } from "../../src";
import type { App } from "../../src";
import type { H3CorsOptions } from "../../src/utils/cors";

describe("handleCors options", () => {
  let app: App;
  let request: TestAgent;

  function mount(options: H3CorsOptions) {
    app.use(
      eventHandler((event) => {
        if (handleCors(event, options)) {
          return;
        }
        return "ok";
      }),
    );
  }

  const ORIGIN = "https://app.example.com";

  beforeEach(() => {
    app = createApp({ debug: true });
    request = supertest(toNodeListener(app));
  });

  it("advertises every method on a preflight when the caller named none", async () => {
    mount({ origin: [ORIGIN] });

    const result = await request
      .options("/")
      .set("origin", ORIGIN)
      .set("access-control-request-method", "DELETE");

    expect(result.status).toEqual(204);
    expect(result.headers["access-control-allow-origin"]).toEqual(ORIGIN);
    expect(result.headers["access-control-allow-methods"]).toEqual("*");
  });

  it("exposes every header on a preflight when the caller named none", async () => {
    mount({ origin: [ORIGIN] });

    const result = await request
      .options("/")
      .set("origin", ORIGIN)
      .set("access-control-request-method", "GET");

    expect(result.headers["access-control-expose-headers"]).toEqual("*");
    expect(result.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(result.headers.vary).toContain("origin");
  });

  it("echoes the requested headers when the caller named none", async () => {
    mount({ origin: [ORIGIN] });

    const result = await request
      .options("/")
      .set("origin", ORIGIN)
      .set("access-control-request-method", "POST")
      .set("access-control-request-headers", "x-api-key");

    expect(result.headers["access-control-allow-headers"]).toEqual("x-api-key");
  });

  it("uses what the caller named instead of the default", async () => {
    mount({
      origin: "*",
      methods: ["GET", "POST"],
      allowHeaders: ["x-api-key"],
      exposeHeaders: ["x-request-id"],
      credentials: true,
      maxAge: "600",
    });

    const result = await request
      .options("/")
      .set("origin", ORIGIN)
      .set("access-control-request-method", "POST");

    expect(result.headers["access-control-allow-methods"]).toEqual("GET,POST");
    expect(result.headers["access-control-allow-headers"]).toEqual("x-api-key");
    expect(result.headers["access-control-expose-headers"]).toEqual(
      "x-request-id",
    );
    expect(result.headers["access-control-allow-credentials"]).toEqual("true");
  });

  it("lets the browser cache the preflight", async () => {
    mount({ origin: [ORIGIN], maxAge: "600" });

    const result = await request
      .options("/")
      .set("origin", ORIGIN)
      .set("access-control-request-method", "PUT");

    expect(result.headers["access-control-max-age"]).toEqual("600");
  });

  it("does not put a max age on a simple response", async () => {
    mount({ origin: [ORIGIN], maxAge: "600" });

    const result = await request.get("/").set("origin", ORIGIN);

    expect(result.text).toEqual("ok");
    expect(result.headers["access-control-max-age"]).toBeUndefined();
  });

  it("keeps the preflight status the caller asked for", async () => {
    mount({ origin: [ORIGIN], preflight: { statusCode: 200 } });

    const result = await request
      .options("/")
      .set("origin", ORIGIN)
      .set("access-control-request-method", "GET");

    expect(result.status).toEqual(200);
  });

  it("carries the defaults on a simple response too", async () => {
    mount({ origin: [ORIGIN] });

    const result = await request.get("/").set("origin", ORIGIN);

    expect(result.status).toEqual(200);
    expect(result.text).toEqual("ok");
    expect(result.headers["access-control-allow-origin"]).toEqual(ORIGIN);
    expect(result.headers["access-control-expose-headers"]).toEqual("*");
    expect(result.headers["access-control-allow-methods"]).toBeUndefined();
  });

  it("defaults to letting everything through when given no options", async () => {
    mount({});

    const result = await request
      .options("/")
      .set("origin", ORIGIN)
      .set("access-control-request-method", "PATCH");

    expect(result.status).toEqual(204);
    expect(result.headers["access-control-allow-origin"]).toEqual("*");
    expect(result.headers["access-control-allow-methods"]).toEqual("*");
    expect(result.headers["access-control-expose-headers"]).toEqual("*");
  });

  it("stays out of the way of an origin it does not allow", async () => {
    mount({ origin: [ORIGIN] });

    const result = await request
      .get("/")
      .set("origin", "https://evil.example.com");

    expect(result.status).toEqual(200);
    expect(result.text).toEqual("ok");
    expect(result.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

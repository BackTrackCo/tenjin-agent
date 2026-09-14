import supertest from "supertest";
import type TestAgent from "supertest/lib/agent";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createApp, toNodeListener, eventHandler } from "../../src";
import type { App } from "../../src";

const ORIGIN = "https://app.example.com";

describe("per-route cors", () => {
  let app: App;
  let request: TestAgent;
  const handler = vi.fn();

  beforeEach(() => {
    handler.mockReset();
    handler.mockImplementation(() => "ok");
    app = createApp({ debug: true });
    request = supertest(toNodeListener(app));
  });

  function mount(cors: unknown, route = "/widgets") {
    app.use(
      route,
      eventHandler({
        cors,
        handler,
      } as any),
    );
  }

  it("answers a preflight for the route without running the handler", async () => {
    mount({ origin: [ORIGIN] });

    const result = await request
      .options("/widgets")
      .set("origin", ORIGIN)
      .set("access-control-request-method", "DELETE");

    expect(result.status).toEqual(204);
    expect(handler).not.toHaveBeenCalled();
    expect(result.headers["access-control-allow-origin"]).toEqual(ORIGIN);
  });

  it("advertises every method and exposes every header by default", async () => {
    mount({ origin: [ORIGIN] });

    const result = await request
      .options("/widgets")
      .set("origin", ORIGIN)
      .set("access-control-request-method", "PUT");

    expect(result.headers["access-control-allow-methods"]).toEqual("*");
    expect(result.headers["access-control-expose-headers"]).toEqual("*");
  });

  it("uses the methods the route named", async () => {
    mount({ origin: [ORIGIN], methods: ["GET", "POST"] });

    const result = await request
      .options("/widgets")
      .set("origin", ORIGIN)
      .set("access-control-request-method", "POST");

    expect(result.headers["access-control-allow-methods"]).toEqual("GET,POST");
  });

  it("puts the headers on an ordinary response and runs the handler", async () => {
    mount({ origin: [ORIGIN] });

    const result = await request.get("/widgets").set("origin", ORIGIN);

    expect(result.status).toEqual(200);
    expect(result.text).toEqual("ok");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.headers["access-control-allow-origin"]).toEqual(ORIGIN);
    expect(result.headers["access-control-expose-headers"]).toEqual("*");
  });

  it("takes true as allow anything", async () => {
    mount(true);

    const result = await request
      .options("/widgets")
      .set("origin", ORIGIN)
      .set("access-control-request-method", "PATCH");

    expect(result.status).toEqual(204);
    expect(result.headers["access-control-allow-origin"]).toEqual("*");
    expect(result.headers["access-control-allow-methods"]).toEqual("*");
  });

  it("gives an origin it does not allow no allow-origin header", async () => {
    mount({ origin: [ORIGIN] });

    const result = await request
      .get("/widgets")
      .set("origin", "https://evil.example.com");

    expect(result.status).toEqual(200);
    expect(result.text).toEqual("ok");
    expect(result.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("leaves a route that did not ask for cors alone", async () => {
    app.use(
      "/plain",
      eventHandler(() => "plain"),
    );

    const result = await request.get("/plain").set("origin", ORIGIN);

    expect(result.text).toEqual("plain");
    expect(result.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("still runs the route's other hooks", async () => {
    const onRequest = vi.fn();
    app.use(
      "/widgets",
      eventHandler({
        cors: { origin: [ORIGIN] },
        onRequest,
        handler,
      } as any),
    );

    const result = await request.get("/widgets").set("origin", ORIGIN);

    expect(result.text).toEqual("ok");
    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(result.headers["access-control-allow-origin"]).toEqual(ORIGIN);
  });
});

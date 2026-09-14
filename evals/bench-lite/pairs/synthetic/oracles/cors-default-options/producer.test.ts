import supertest from "supertest";
import type TestAgent from "supertest/lib/agent";
import { describe, it, expect, vi } from "vitest";
import {
  createApp,
  toNodeListener,
  eventHandler,
  createError,
} from "../../src";
import type { AppOptions } from "../../src";

const ORIGIN = "https://app.example.com";

describe("createApp cors option", () => {
  const handler = vi.fn();

  function appWith(options: AppOptions): TestAgent {
    handler.mockReset();
    handler.mockImplementation(() => "ok");
    const app = createApp({ debug: true, ...options });
    app.use(eventHandler(handler));
    return supertest(toNodeListener(app));
  }

  it("answers a preflight without running the handler", async () => {
    const request = appWith({ cors: { origin: [ORIGIN] } });

    const result = await request
      .options("/")
      .set("origin", ORIGIN)
      .set("access-control-request-method", "DELETE");

    expect(result.status).toEqual(204);
    expect(handler).not.toHaveBeenCalled();
    expect(result.headers["access-control-allow-origin"]).toEqual(ORIGIN);
  });

  it("advertises every method and exposes every header by default", async () => {
    const request = appWith({ cors: { origin: [ORIGIN] } });

    const result = await request
      .options("/")
      .set("origin", ORIGIN)
      .set("access-control-request-method", "PUT");

    expect(result.headers["access-control-allow-methods"]).toEqual("*");
    expect(result.headers["access-control-expose-headers"]).toEqual("*");
  });

  it("uses the methods the app named", async () => {
    const request = appWith({
      cors: { origin: [ORIGIN], methods: ["GET", "POST"] },
    });

    const result = await request
      .options("/")
      .set("origin", ORIGIN)
      .set("access-control-request-method", "POST");

    expect(result.headers["access-control-allow-methods"]).toEqual("GET,POST");
  });

  it("puts the headers on an ordinary response and still runs the handler", async () => {
    const request = appWith({ cors: { origin: [ORIGIN] } });

    const result = await request.get("/").set("origin", ORIGIN);

    expect(result.status).toEqual(200);
    expect(result.text).toEqual("ok");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.headers["access-control-allow-origin"]).toEqual(ORIGIN);
    expect(result.headers["access-control-expose-headers"]).toEqual("*");
    expect(result.headers["access-control-allow-methods"]).toBeUndefined();
  });

  it("keeps the headers when the handler throws", async () => {
    const request = appWith({ cors: { origin: [ORIGIN] } });
    handler.mockImplementation(() => {
      throw createError({ statusCode: 418, statusMessage: "teapot" });
    });

    const result = await request.get("/").set("origin", ORIGIN);

    expect(result.status).toEqual(418);
    expect(result.headers["access-control-allow-origin"]).toEqual(ORIGIN);
  });

  it("gives an origin it does not allow no allow-origin header", async () => {
    const request = appWith({ cors: { origin: [ORIGIN] } });

    const result = await request
      .get("/")
      .set("origin", "https://evil.example.com");

    expect(result.status).toEqual(200);
    expect(result.text).toEqual("ok");
    expect(result.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("takes true as allow anything", async () => {
    const request = appWith({ cors: true });

    const result = await request
      .options("/")
      .set("origin", ORIGIN)
      .set("access-control-request-method", "PATCH");

    expect(result.status).toEqual(204);
    expect(result.headers["access-control-allow-origin"]).toEqual("*");
    expect(result.headers["access-control-allow-methods"]).toEqual("*");
    expect(result.headers["access-control-expose-headers"]).toEqual("*");
  });

  it("does nothing at all when the app did not ask for cors", async () => {
    const request = appWith({});

    const result = await request.get("/").set("origin", ORIGIN);

    expect(result.status).toEqual(200);
    expect(result.headers["access-control-allow-origin"]).toBeUndefined();
    expect(result.headers["access-control-expose-headers"]).toBeUndefined();

    const preflight = await request
      .options("/")
      .set("origin", ORIGIN)
      .set("access-control-request-method", "DELETE");

    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

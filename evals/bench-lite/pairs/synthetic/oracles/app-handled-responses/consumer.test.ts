import supertest from "supertest";
import type TestAgent from "supertest/lib/agent";
import { describe, it, expect } from "vitest";
import {
  createApp,
  toNodeListener,
  eventHandler,
  sendRedirect,
  sendNoContent,
  send,
  createError,
  setResponseHeader,
} from "../../src";
import type { EventHandler } from "../../src";

const HEADERS = { "x-served-by": "h3-edge-1", "x-api-version": "2026-01" };

function appWith(handler: EventHandler, headers = HEADERS): TestAgent {
  const app = createApp({ debug: true, responseHeaders: headers });
  app.use(handler);
  return supertest(toNodeListener(app));
}

describe("app responseHeaders", () => {
  it("is on a response the handler returned", async () => {
    const result = await appWith(eventHandler(() => "hello")).get("/");

    expect(result.text).toEqual("hello");
    expect(result.headers["x-served-by"]).toEqual("h3-edge-1");
    expect(result.headers["x-api-version"]).toEqual("2026-01");
  });

  it("is on a redirect", async () => {
    const result = await appWith(
      eventHandler((event) => sendRedirect(event, "/elsewhere", 302)),
    ).get("/");

    expect(result.status).toEqual(302);
    expect(result.headers.location).toEqual("/elsewhere");
    expect(result.headers["x-served-by"]).toEqual("h3-edge-1");
  });

  it("is on an empty response", async () => {
    const result = await appWith(
      eventHandler((event) => sendNoContent(event, 204)),
    ).get("/");

    expect(result.status).toEqual(204);
    expect(result.headers["x-served-by"]).toEqual("h3-edge-1");
  });

  it("is on a body the handler wrote itself", async () => {
    const result = await appWith(
      eventHandler((event) => send(event, "written", "text/plain")),
    ).get("/");

    expect(result.text).toEqual("written");
    expect(result.headers["x-served-by"]).toEqual("h3-edge-1");
  });

  it("is on a 404 nothing in the stack answered", async () => {
    const result = await appWith(eventHandler(() => undefined)).get("/");

    expect(result.status).toEqual(404);
    expect(result.headers["x-served-by"]).toEqual("h3-edge-1");
  });

  it("is on an error response", async () => {
    const result = await appWith(
      eventHandler(() => {
        throw createError({ statusCode: 418, statusMessage: "teapot" });
      }),
    ).get("/");

    expect(result.status).toEqual(418);
    expect(result.headers["x-served-by"]).toEqual("h3-edge-1");
  });

  it("gives way to a header the handler set itself", async () => {
    const result = await appWith(
      eventHandler((event) => {
        setResponseHeader(event, "x-served-by", "handler");
        return "hello";
      }),
    ).get("/");

    expect(result.headers["x-served-by"]).toEqual("handler");
    expect(result.headers["x-api-version"]).toEqual("2026-01");
  });

  it("adds nothing when the app did not ask for it", async () => {
    const app = createApp({ debug: true });
    app.use(eventHandler(() => "hello"));

    const result = await supertest(toNodeListener(app)).get("/");

    expect(result.text).toEqual("hello");
    expect(result.headers["x-served-by"]).toBeUndefined();
  });

  it("takes an empty set without complaining", async () => {
    const result = await appWith(eventHandler(() => "hello"), {}).get("/");

    expect(result.text).toEqual("hello");
    expect(result.headers["x-served-by"]).toBeUndefined();
  });
});

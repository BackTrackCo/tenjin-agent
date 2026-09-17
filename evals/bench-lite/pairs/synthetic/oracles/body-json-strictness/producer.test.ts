import supertest from "supertest";
import type TestAgent from "supertest/lib/agent";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createApp,
  toNodeListener,
  eventHandler,
  readBody,
  readValidatedBody,
} from "../../src";
import type { App, AppOptions } from "../../src";

describe("app onRequestBody", () => {
  const onRequestBody = vi.fn();

  beforeEach(() => {
    onRequestBody.mockReset();
  });

  /** An app whose route echoes the body it read. */
  function echoApp(options: AppOptions = { onRequestBody }): {
    app: App;
    request: TestAgent;
  } {
    const app = createApp({ debug: true, ...options });
    app.use(
      eventHandler(async (event) => {
        return { body: await readBody(event) };
      }),
    );
    return { app, request: supertest(toNodeListener(app)) };
  }

  /** An app whose route insists the body is an object. */
  function validatingApp(options: AppOptions = { onRequestBody }): TestAgent {
    const app = createApp({ debug: true, ...options });
    app.use(
      eventHandler(async (event) => {
        const body = await readValidatedBody(event, (input) =>
          typeof input === "object" && input !== null ? input : false,
        );
        return { body };
      }),
    );
    return supertest(toNodeListener(app));
  }

  it("is given the body that was posted", async () => {
    const { request } = echoApp();

    const result = await request
      .post("/")
      .set("content-type", "application/json")
      .send({ user: "ada" });

    expect(result.status).toEqual(200);
    expect(onRequestBody).toHaveBeenCalledTimes(1);
    expect(onRequestBody.mock.calls[0]?.[1]).toEqual({ user: "ada" });
  });

  it("leaves the body for the handler to read as well", async () => {
    const { request } = echoApp();

    const result = await request
      .post("/")
      .set("content-type", "application/json")
      .send({ user: "ada" });

    expect(result.body.body).toEqual({ user: "ada" });
    expect(onRequestBody).toHaveBeenCalledTimes(1);
  });

  it("is given the event of the request", async () => {
    const { request } = echoApp();

    await request
      .post("/some/path")
      .set("content-type", "application/json")
      .send({ user: "ada" });

    expect(onRequestBody.mock.calls[0]?.[0]?.path).toEqual("/some/path");
  });

  it("stays quiet for a request with no body", async () => {
    const { request } = echoApp();

    await request.get("/");

    expect(onRequestBody).not.toHaveBeenCalled();
  });

  it("does not change how a validating route answers a good body", async () => {
    const request = validatingApp();

    const result = await request
      .post("/")
      .set("content-type", "application/json; charset=utf-8")
      .send('{"user":"ada"}');

    expect(result.status).toEqual(200);
    expect(result.body.body).toEqual({ user: "ada" });
    expect(onRequestBody).toHaveBeenCalledTimes(1);
  });

  it("does not change how a validating route rejects a broken body", async () => {
    const withHook = validatingApp();
    const withoutHook = validatingApp({});

    const expected = await withoutHook
      .post("/")
      .set("content-type", "application/json; charset=utf-8")
      .send('{"user":"ada"');

    const actual = await withHook
      .post("/")
      .set("content-type", "application/json; charset=utf-8")
      .send('{"user":"ada"');

    expect(expected.status).toEqual(400);
    expect(actual.status).toEqual(expected.status);
    expect(actual.body.statusMessage).toEqual(expected.body.statusMessage);
  });

  it("does not change how a plain route reads a text body", async () => {
    const { request } = echoApp();

    const result = await request
      .post("/")
      .set("content-type", "text/plain")
      .send("just text");

    expect(result.body.body).toEqual("just text");
    expect(onRequestBody.mock.calls[0]?.[1]).toEqual("just text");
  });

  it("adds nothing when the app did not ask for it", async () => {
    const { request } = echoApp({});

    const result = await request
      .post("/")
      .set("content-type", "application/json")
      .send({ user: "ada" });

    expect(result.body.body).toEqual({ user: "ada" });
    expect(onRequestBody).not.toHaveBeenCalled();
  });
});

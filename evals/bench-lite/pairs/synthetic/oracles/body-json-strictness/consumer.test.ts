import supertest from "supertest";
import type TestAgent from "supertest/lib/agent";
import { describe, it, expect, beforeEach } from "vitest";
import { createApp, toNodeListener, eventHandler, readBody } from "../../src";
import type { App } from "../../src";

describe("readBody limit", () => {
  let app: App;
  let request: TestAgent;

  beforeEach(() => {
    app = createApp({ debug: true });
    request = supertest(toNodeListener(app));
  });

  /** 40 bytes of JSON. */
  const BODY = '{"note":"0123456789012345678901234"}';

  function readWithLimit(limit?: number) {
    app.use(
      eventHandler(async (event) => {
        const body = await readBody(event, limit === undefined ? {} : { limit });
        return { body };
      }),
    );
  }

  it("takes a body inside the limit", async () => {
    readWithLimit(1024);

    const result = await request
      .post("/")
      .set("content-type", "application/json")
      .send(BODY);

    expect(result.status).toEqual(200);
    expect(result.body.body).toEqual({ note: "0123456789012345678901234" });
  });

  it("takes a body of exactly the limit", async () => {
    readWithLimit(Buffer.byteLength(BODY));

    const result = await request
      .post("/")
      .set("content-type", "application/json")
      .send(BODY);

    expect(result.status).toEqual(200);
  });

  it("rejects a body over the limit", async () => {
    readWithLimit(Buffer.byteLength(BODY) - 1);

    const result = await request
      .post("/")
      .set("content-type", "application/json")
      .send(BODY);

    expect(result.status).toEqual(413);
    expect(result.body).toMatchObject({ statusCode: 413 });
  });

  it("counts bytes, not characters", async () => {
    // Six characters, ten bytes: four of them are two-byte.
    const text = "aéîöub";
    readWithLimit(Buffer.byteLength(text) - 1);

    const result = await request
      .post("/")
      .set("content-type", "text/plain")
      .send(text);

    expect(result.status).toEqual(413);
  });

  it("rejects an oversized body a layer had already read", async () => {
    app.use(
      eventHandler(async (event) => {
        await readBody(event);
      }),
    );
    readWithLimit(Buffer.byteLength(BODY) - 1);

    const result = await request
      .post("/")
      .set("content-type", "application/json")
      .send(BODY);

    expect(result.status).toEqual(413);
    expect(result.body).toMatchObject({ statusCode: 413 });
  });

  it("still returns the body to a second reader inside the limit", async () => {
    app.use(
      eventHandler(async (event) => {
        await readBody(event);
      }),
    );
    readWithLimit(1024);

    const result = await request
      .post("/")
      .set("content-type", "application/json")
      .send(BODY);

    expect(result.status).toEqual(200);
    expect(result.body.body).toEqual({ note: "0123456789012345678901234" });
  });

  it("does not limit anything when no limit was given", async () => {
    readWithLimit();

    const result = await request
      .post("/")
      .set("content-type", "application/json")
      .send(BODY);

    expect(result.status).toEqual(200);
    expect(result.body.body).toEqual({ note: "0123456789012345678901234" });
  });

  it("takes an empty body under any limit", async () => {
    readWithLimit(1);

    const result = await request.post("/").set("content-type", "text/plain");

    expect(result.status).toEqual(200);
  });
});

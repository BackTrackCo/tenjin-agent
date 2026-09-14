import supertest from "supertest";
import type TestAgent from "supertest/lib/agent";
import { describe, it, expect, beforeEach } from "vitest";
import { createApp, toNodeListener, eventHandler, readBody } from "../../src";
import type { App } from "../../src";

describe("readBody json strictness", () => {
  let app: App;
  let request: TestAgent;

  beforeEach(() => {
    app = createApp({ debug: true });
    request = supertest(toNodeListener(app));
  });

  function echoBody() {
    app.use(
      eventHandler(async (event) => {
        const body = await readBody(event);
        return { type: typeof body, body };
      }),
    );
  }

  it("rejects a malformed body sent as application/json", async () => {
    echoBody();

    const result = await request
      .post("/")
      .set("content-type", "application/json")
      .send('{"a":1');

    expect(result.status).toEqual(400);
    expect(result.body).toMatchObject({ statusCode: 400 });
  });

  it("rejects a malformed body when the type carries a charset", async () => {
    echoBody();

    const result = await request
      .post("/")
      .set("content-type", "application/json; charset=utf-8")
      .send('{"a":1');

    expect(result.status).toEqual(400);
    expect(result.body).toMatchObject({ statusCode: 400 });
  });

  it("rejects a malformed body on a +json media type", async () => {
    echoBody();

    const result = await request
      .post("/")
      .set("content-type", "application/vnd.api+json")
      .send('{"a":1');

    expect(result.status).toEqual(400);
  });

  it("parses a good body that carries a charset", async () => {
    echoBody();

    const result = await request
      .post("/")
      .set("content-type", "application/json; charset=utf-8")
      .send('{"a":1}');

    expect(result.status).toEqual(200);
    expect(result.body).toEqual({ type: "object", body: { a: 1 } });
  });

  it("parses a good body on a +json media type", async () => {
    echoBody();

    const result = await request
      .post("/")
      .set("content-type", "application/vnd.api+json")
      .send('{"a":1}');

    expect(result.status).toEqual(200);
    expect(result.body).toEqual({ type: "object", body: { a: 1 } });
  });

  it("leaves text bodies alone", async () => {
    echoBody();

    const result = await request
      .post("/")
      .set("content-type", "text/plain")
      .send('{"a":1');

    expect(result.status).toEqual(200);
    expect(result.body).toEqual({ type: "string", body: '{"a":1' });
  });

  it("leaves form bodies alone", async () => {
    echoBody();

    const result = await request
      .post("/")
      .set("content-type", "application/x-www-form-urlencoded")
      .send("a=1&b=2");

    expect(result.status).toEqual(200);
    expect(result.body.body).toEqual({ a: "1", b: "2" });
  });

  it("still lets a caller ask for the lenient parse", async () => {
    app.use(
      eventHandler(async (event) => {
        const body = await readBody(event, { strict: false });
        return { type: typeof body, body };
      }),
    );

    const result = await request
      .post("/")
      .set("content-type", "application/json; charset=utf-8")
      .send('{"a":1');

    expect(result.status).toEqual(200);
    expect(result.body).toEqual({ type: "string", body: '{"a":1' });
  });

  it("rejects the malformed body even when a layer already read it leniently", async () => {
    app.use(
      eventHandler(async (event) => {
        await readBody(event, { strict: false });
      }),
    );
    echoBody();

    const result = await request
      .post("/")
      .set("content-type", "application/json")
      .send('{"a":1');

    expect(result.status).toEqual(400);
    expect(result.body).toMatchObject({ statusCode: 400 });
  });

  it("gives every reader the same good body", async () => {
    const seen: unknown[] = [];
    app.use(
      eventHandler(async (event) => {
        seen.push(await readBody(event));
      }),
    );
    app.use(
      eventHandler(async (event) => {
        seen.push(await readBody(event));
        return { count: seen.length, same: seen[0], second: seen[1] };
      }),
    );

    const result = await request
      .post("/")
      .set("content-type", "application/json; charset=utf-8")
      .send('{"a":1}');

    expect(result.status).toEqual(200);
    expect(result.body).toEqual({
      count: 2,
      same: { a: 1 },
      second: { a: 1 },
    });
  });
});

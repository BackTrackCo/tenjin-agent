import supertest from "supertest";
import type TestAgent from "supertest/lib/agent";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createApp,
  toNodeListener,
  eventHandler,
  useSession,
  readBody,
} from "../../src";
import type { App, SessionConfig } from "../../src";

const PASSWORD = "1234567123456712345671234567123456712345671234567";
const OTHER_PASSWORD = "abcdefgabcdefgabcdefgabcdefgabcdefgabcdefgabcdefg";
const START = new Date("2026-03-04T12:00:00.000Z");

describe("session restore failures", () => {
  let app: App;
  let request: TestAgent;
  let idCounter: number;
  const onRestoreError = vi.fn();

  function mount(config: Partial<SessionConfig> = {}) {
    const sessionConfig: SessionConfig = {
      name: "h3-test",
      password: PASSWORD,
      generateId: () => String(++idCounter),
      onRestoreError,
      ...config,
    } as SessionConfig;

    app.use(
      eventHandler(async (event) => {
        const session = await useSession(event, sessionConfig);
        if (event.method === "POST") {
          await session.update(await readBody(event));
        }
        return { id: session.id, data: session.data };
      }),
    );
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START);
    idCounter = 0;
    onRestoreError.mockReset();
    app = createApp({ debug: true });
    request = supertest(toNodeListener(app));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function cookieOf(result: { headers: Record<string, any> }): string {
    return result.headers["set-cookie"][0];
  }

  function advance(seconds: number) {
    vi.setSystemTime(new Date(Date.now() + seconds * 1000));
  }

  it("says nothing when there was no session to restore", async () => {
    mount();

    const result = await request.get("/");

    expect(result.body.id).toEqual("1");
    expect(onRestoreError).not.toHaveBeenCalled();
  });

  it("says nothing when the session restores", async () => {
    mount();

    const first = await request.post("/").send({ user: "ada" });
    const second = await request.get("/").set("Cookie", cookieOf(first));

    expect(second.body.data).toEqual({ user: "ada" });
    expect(onRestoreError).not.toHaveBeenCalled();
  });

  it("says nothing for a restored session that holds no data", async () => {
    mount();

    const first = await request.get("/");
    const second = await request.get("/").set("Cookie", cookieOf(first));

    expect(second.body.id).toEqual("1");
    expect(second.body.data).toEqual({});
    expect(onRestoreError).not.toHaveBeenCalled();
  });

  it("reports a tampered token as invalid", async () => {
    mount();

    const result = await request
      .get("/")
      .set("Cookie", "h3-test=not-a-real-session-token");

    expect(onRestoreError).toHaveBeenCalledTimes(1);
    expect(onRestoreError.mock.calls[0]?.[1]).toMatchObject({
      reason: "invalid",
    });
    expect(onRestoreError.mock.calls[0]?.[1]?.error).toBeInstanceOf(Error);
    expect(result.body.id).toEqual("1");
  });

  it("reports a token sealed with another password as invalid", async () => {
    const other = createApp({ debug: true });
    other.use(
      eventHandler(async (event) => {
        const session = await useSession(event, {
          name: "h3-test",
          password: OTHER_PASSWORD,
        });
        return { id: session.id };
      }),
    );
    const foreign = await supertest(toNodeListener(other)).get("/");

    mount();
    await request.get("/").set("Cookie", cookieOf(foreign));

    expect(onRestoreError).toHaveBeenCalledTimes(1);
    expect(onRestoreError.mock.calls[0]?.[1]).toMatchObject({
      reason: "invalid",
    });
  });

  it("reports a token past its window as expired", async () => {
    mount({ maxAge: 60 });

    const first = await request.get("/");
    const cookie = cookieOf(first);

    advance(70);
    const second = await request.get("/").set("Cookie", cookie);

    expect(onRestoreError).toHaveBeenCalledTimes(1);
    expect(onRestoreError.mock.calls[0]?.[1]).toMatchObject({
      reason: "expired",
    });
    expect(second.body.id).toEqual("2");
    expect(second.body.data).toEqual({});
  });

  it("says nothing while the token is still inside its window", async () => {
    mount({ maxAge: 60 });

    const first = await request.get("/");

    advance(30);
    await request.get("/").set("Cookie", cookieOf(first));

    expect(onRestoreError).not.toHaveBeenCalled();
  });

  it("hands the callback the event it happened on", async () => {
    mount();

    await request
      .get("/some/path")
      .set("Cookie", "h3-test=not-a-real-session-token");

    expect(onRestoreError.mock.calls[0]?.[0]?.path).toEqual("/some/path");
  });

  it("still works without the callback", async () => {
    idCounter = 0;
    const plain = createApp({ debug: true });
    plain.use(
      eventHandler(async (event) => {
        const session = await useSession(event, {
          name: "h3-test",
          password: PASSWORD,
          generateId: () => String(++idCounter),
        });
        return { id: session.id };
      }),
    );

    const result = await supertest(toNodeListener(plain))
      .get("/")
      .set("Cookie", "h3-test=not-a-real-session-token");

    expect(result.body.id).toEqual("1");
  });
});

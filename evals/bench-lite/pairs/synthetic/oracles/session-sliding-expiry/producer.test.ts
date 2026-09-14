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
const START = new Date("2026-03-04T12:00:00.000Z");

describe("rolling sessions", () => {
  let app: App;
  let request: TestAgent;
  let idCounter: number;

  function mount(config: Partial<SessionConfig>) {
    const sessionConfig: SessionConfig = {
      name: "h3-test",
      password: PASSWORD,
      generateId: () => String(++idCounter),
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
    app = createApp({ debug: true });
    request = supertest(toNodeListener(app));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  type Result = { headers: Record<string, any>; body: any };

  /** The cookie to send next: a freshly issued one, or the one we already had. */
  function nextCookie(result: Result, previous: string): string {
    const issued = result.headers["set-cookie"];
    return issued ? issued[0] : previous;
  }

  function expiryOf(cookie: string): number {
    return Date.parse(/expires=([^;]+)/i.exec(cookie)?.[1] ?? "");
  }

  function advance(seconds: number) {
    vi.setSystemTime(new Date(Date.now() + seconds * 1000));
  }

  it("keeps a session alive while it is being used", async () => {
    mount({ maxAge: 60, rolling: true });

    const first = await request.get("/");
    expect(first.body.id).toEqual("1");
    let cookie = nextCookie(first, "");

    advance(50);
    const second = await request.get("/").set("Cookie", cookie);
    expect(second.body.id).toEqual("1");
    cookie = nextCookie(second, cookie);

    advance(50);
    const third = await request.get("/").set("Cookie", cookie);
    expect(third.body.id).toEqual("1");
  });

  it("keeps the data across the original window", async () => {
    mount({ maxAge: 60, rolling: true });

    const first = await request.post("/").send({ user: "ada" });
    expect(first.body.data).toEqual({ user: "ada" });
    let cookie = nextCookie(first, "");

    advance(50);
    const second = await request.get("/").set("Cookie", cookie);
    cookie = nextCookie(second, cookie);

    advance(50);
    const third = await request.get("/").set("Cookie", cookie);
    expect(third.body.data).toEqual({ user: "ada" });
    expect(third.body.id).toEqual("1");
  });

  it("re-issues the cookie on every visit", async () => {
    mount({ maxAge: 60, rolling: true });

    const first = await request.get("/");
    const cookie = nextCookie(first, "");

    advance(50);
    const second = await request.get("/").set("Cookie", cookie);

    expect(second.headers["set-cookie"]).toBeTruthy();
    expect(expiryOf(second.headers["set-cookie"][0]) - expiryOf(cookie)).toBeGreaterThanOrEqual(
      45_000,
    );
  });

  it("lets a session that went quiet expire", async () => {
    mount({ maxAge: 60, rolling: true });

    const first = await request.get("/");
    const cookie = nextCookie(first, "");

    advance(70);
    const second = await request.get("/").set("Cookie", cookie);

    expect(second.body.id).toEqual("2");
    expect(second.body.data).toEqual({});
  });

  it("leaves a session without rolling on its original window", async () => {
    mount({ maxAge: 60 });

    const first = await request.get("/");
    let cookie = nextCookie(first, "");
    expect(first.body.id).toEqual("1");

    advance(50);
    const second = await request.get("/").set("Cookie", cookie);
    expect(second.body.id).toEqual("1");
    cookie = nextCookie(second, cookie);

    advance(50);
    const third = await request.get("/").set("Cookie", cookie);
    expect(third.body.id).toEqual("2");
  });

  it("does not re-issue the cookie without rolling", async () => {
    mount({ maxAge: 60 });

    const first = await request.get("/");
    const cookie = nextCookie(first, "");

    advance(10);
    const second = await request.get("/").set("Cookie", cookie);

    expect(second.body.id).toEqual("1");
    expect(second.headers["set-cookie"]).toBeUndefined();
  });

  it("does nothing surprising without a maxAge", async () => {
    mount({ rolling: true });

    const first = await request.get("/");
    const cookie = nextCookie(first, "");

    advance(10_000);
    const second = await request.get("/").set("Cookie", cookie);

    expect(second.body.id).toEqual("1");
  });
});

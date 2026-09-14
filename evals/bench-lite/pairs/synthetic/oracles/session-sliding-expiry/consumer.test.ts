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

describe("renewing a session", () => {
  let app: App;
  let request: TestAgent;
  let idCounter: number;

  function mount(config: Partial<SessionConfig> = {}) {
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
        if (event.path === "/renew") {
          const returned = await session.renew();
          return {
            id: session.id,
            data: session.data,
            chainable: typeof returned?.update === "function",
          };
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

  it("keeps the session it renewed", async () => {
    mount({ maxAge: 60 });

    const first = await request.post("/").send({ user: "ada" });
    const cookie = nextCookie(first, "");

    const renewed = await request.get("/renew").set("Cookie", cookie);

    expect(renewed.body.id).toEqual("1");
    expect(renewed.body.data).toEqual({ user: "ada" });
    expect(renewed.body.chainable).toBe(true);
  });

  it("starts the window again", async () => {
    mount({ maxAge: 60 });

    const first = await request.post("/").send({ user: "ada" });
    let cookie = nextCookie(first, "");

    advance(50);
    const renewed = await request.get("/renew").set("Cookie", cookie);
    cookie = nextCookie(renewed, cookie);

    advance(50);
    const later = await request.get("/").set("Cookie", cookie);

    expect(later.body.id).toEqual("1");
    expect(later.body.data).toEqual({ user: "ada" });
  });

  it("issues a cookie that expires later than the one before it", async () => {
    mount({ maxAge: 60 });

    const first = await request.get("/");
    const cookie = nextCookie(first, "");

    advance(50);
    const renewed = await request.get("/renew").set("Cookie", cookie);

    expect(renewed.headers["set-cookie"]).toBeTruthy();
    expect(
      expiryOf(renewed.headers["set-cookie"][0]) - expiryOf(cookie),
    ).toBeGreaterThanOrEqual(45_000);
  });

  it("does not keep a session alive that was never renewed", async () => {
    mount({ maxAge: 60 });

    const first = await request.post("/").send({ user: "ada" });
    const cookie = nextCookie(first, "");

    advance(70);
    const later = await request.get("/").set("Cookie", cookie);

    expect(later.body.id).toEqual("2");
    expect(later.body.data).toEqual({});
  });

  it("can be renewed more than once", async () => {
    mount({ maxAge: 60 });

    const first = await request.post("/").send({ user: "ada" });
    let cookie = nextCookie(first, "");

    for (const _ of [1, 2, 3]) {
      advance(50);
      const renewed = await request.get("/renew").set("Cookie", cookie);
      cookie = nextCookie(renewed, cookie);
      expect(renewed.body.id).toEqual("1");
    }

    advance(50);
    const later = await request.get("/").set("Cookie", cookie);
    expect(later.body.data).toEqual({ user: "ada" });
  });

  it("is harmless on a session that has only just started", async () => {
    mount({ maxAge: 60 });

    const renewed = await request.get("/renew");

    expect(renewed.body.id).toEqual("1");
    expect(renewed.headers["set-cookie"]).toBeTruthy();
  });

  it("works on a session with no maxAge at all", async () => {
    mount({});

    const first = await request.post("/").send({ user: "ada" });
    const cookie = nextCookie(first, "");

    const renewed = await request.get("/renew").set("Cookie", cookie);

    expect(renewed.body.id).toEqual("1");
    expect(renewed.body.data).toEqual({ user: "ada" });
  });
});

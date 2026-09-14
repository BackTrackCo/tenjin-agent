import { describe, it, expect } from "vitest";
import {
  formatEventStreamMessage,
  formatEventStreamMessages,
} from "../../src/utils/sse/utils";

describe("event stream data serialisation", () => {
  it("sends an object as JSON", () => {
    expect(formatEventStreamMessage({ data: { pct: 40, stage: "build" } })).toEqual(
      'data: {"pct":40,"stage":"build"}\n\n',
    );
  });

  it("sends an array as JSON", () => {
    expect(formatEventStreamMessage({ data: [1, 2, 3] })).toEqual(
      "data: [1,2,3]\n\n",
    );
  });

  it("sends a number, a boolean and null as JSON", () => {
    expect(formatEventStreamMessage({ data: 40 })).toEqual("data: 40\n\n");
    expect(formatEventStreamMessage({ data: false })).toEqual(
      "data: false\n\n",
    );
    expect(formatEventStreamMessage({ data: null })).toEqual("data: null\n\n");
  });

  it("sends a string as it is", () => {
    expect(formatEventStreamMessage({ data: "hello world" })).toEqual(
      "data: hello world\n\n",
    );
  });

  it("does not quote a string that looks like JSON", () => {
    expect(formatEventStreamMessage({ data: '{"already":"json"}' })).toEqual(
      'data: {"already":"json"}\n\n',
    );
  });

  it("splits a multi-line string over several data lines", () => {
    expect(formatEventStreamMessage({ data: "first\nsecond" })).toEqual(
      "data: first\ndata: second\n\n",
    );
  });

  it("splits a serialised value over several data lines when it has newlines", () => {
    expect(
      formatEventStreamMessage({ data: JSON.parse('"a\\nb"') as unknown }),
    ).toEqual("data: a\ndata: b\n\n");
  });

  it("keeps the event name alongside the serialised data", () => {
    expect(
      formatEventStreamMessage({ event: "progress", data: { pct: 40 } }),
    ).toEqual('event: progress\ndata: {"pct":40}\n\n');
  });

  it("sends an empty data line for an undefined payload", () => {
    expect(formatEventStreamMessage({ data: undefined })).toEqual(
      "data: \n\n",
    );
  });

  it("serialises every message of a batch", () => {
    expect(
      formatEventStreamMessages([
        { data: { n: 1 } },
        { data: "two" },
        { data: 3 },
      ]),
    ).toEqual('data: {"n":1}\n\ndata: two\n\ndata: 3\n\n');
  });
});

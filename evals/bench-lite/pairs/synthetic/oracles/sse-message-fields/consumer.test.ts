import { describe, it, expect } from "vitest";
import { formatEventStreamMessage } from "../../src/utils/sse/utils";

describe("event stream id and retry fields", () => {
  it("sends a numeric id", () => {
    expect(formatEventStreamMessage({ id: 7, data: "x" })).toEqual(
      "id: 7\ndata: x\n\n",
    );
  });

  it("sends the id zero", () => {
    expect(formatEventStreamMessage({ id: 0, data: "x" })).toEqual(
      "id: 0\ndata: x\n\n",
    );
  });

  it("sends a string id", () => {
    expect(formatEventStreamMessage({ id: "42", data: "x" })).toEqual(
      "id: 42\ndata: x\n\n",
    );
  });

  it("leaves out an id that was not set", () => {
    expect(formatEventStreamMessage({ data: "x" })).toEqual("data: x\n\n");
    expect(formatEventStreamMessage({ id: "", data: "x" })).toEqual(
      "data: x\n\n",
    );
  });

  it("strips newlines out of an id", () => {
    expect(formatEventStreamMessage({ id: "4\n2", data: "x" })).toEqual(
      "id: 42\ndata: x\n\n",
    );
  });

  it("sends a retry given as a number", () => {
    expect(formatEventStreamMessage({ retry: 1500, data: "x" })).toEqual(
      "retry: 1500\ndata: x\n\n",
    );
  });

  it("sends a retry given as a string of digits", () => {
    expect(formatEventStreamMessage({ retry: "1500", data: "x" })).toEqual(
      "retry: 1500\ndata: x\n\n",
    );
  });

  it("sends the retry zero", () => {
    expect(formatEventStreamMessage({ retry: 0, data: "x" })).toEqual(
      "retry: 0\ndata: x\n\n",
    );
  });

  it("leaves out a retry that is not a whole number of milliseconds", () => {
    expect(formatEventStreamMessage({ retry: 1.5, data: "x" })).toEqual(
      "data: x\n\n",
    );
    expect(formatEventStreamMessage({ retry: -1, data: "x" })).toEqual(
      "data: x\n\n",
    );
    expect(formatEventStreamMessage({ retry: "soon", data: "x" })).toEqual(
      "data: x\n\n",
    );
  });

  it("keeps the field order", () => {
    expect(
      formatEventStreamMessage({
        id: 7,
        event: "progress",
        retry: "1500",
        data: "x",
      }),
    ).toEqual("id: 7\nevent: progress\nretry: 1500\ndata: x\n\n");
  });
});

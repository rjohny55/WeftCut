import { describe, expect, test, vi } from "vitest";
import {
  handleDecodeError,
  type DecodeErrorAction,
} from "./decoderFallback";

const baseArgs = {
  mediaId: "media-1",
  log: () => {},
};

describe("handleDecodeError", () => {
  test.each([undefined, false])('default/export midstream policy remains log-only (%s)', retryMidstreamHardware => {
    const action = handleDecodeError({ ...baseArgs, err: new Error('terminal decode error'), outputFrameCount: 42, alreadyDowngraded: false,
      ...(retryMidstreamHardware === undefined ? {} : { retryMidstreamHardware }) });
    expect(action.kind).toBe('log-only');
  });
  test('preview software failure after output never re-arms hardware retry', () => {
    expect(handleDecodeError({ ...baseArgs, err: new Error('software failed'), outputFrameCount: 33, alreadyDowngraded: true, retryMidstreamHardware: true }).kind).toBe('log-only');
  });
  test("first-frame HW error downgrades to software", () => {
    const action = handleDecodeError({
      ...baseArgs,
      err: new Error("hardware decode failed"),
      outputFrameCount: 0,
      alreadyDowngraded: false,
    });
    expect(action).toEqual<DecodeErrorAction>({ kind: "downgrade-to-software" });
  });

  test("terminal hardware error after frames have flowed retries software once", () => {
    const action = handleDecodeError({
      ...baseArgs,
      err: new Error("transient decode glitch"),
      outputFrameCount: 42,
      alreadyDowngraded: false,
      retryMidstreamHardware: true,
    });
    expect(action.kind).toBe("downgrade-to-software");
  });

  test("already-downgraded handle never downgrades again", () => {
    const action = handleDecodeError({
      ...baseArgs,
      err: new Error("software decode also failed"),
      outputFrameCount: 0,
      alreadyDowngraded: true,
    });
    expect(action.kind).toBe("log-only");
  });

  test("inactivity message triggers rebuild path", () => {
    const action = handleDecodeError({
      ...baseArgs,
      err: new Error("Codec reclaimed due to inactivity"),
      outputFrameCount: 100,
      alreadyDowngraded: false,
    });
    expect(action).toEqual<DecodeErrorAction>({ kind: "inactivity-rebuild" });
  });

  test("inactivity precedence: takes precedence over first-frame downgrade", () => {
    const action = handleDecodeError({
      ...baseArgs,
      err: new Error("Codec reclaimed due to inactivity"),
      outputFrameCount: 0,
      alreadyDowngraded: false,
    });
    expect(action.kind).toBe("inactivity-rebuild");
  });

  test("inactivity warning cites the source mediaId", () => {
    const log = vi.fn();
    handleDecodeError({
      ...baseArgs,
      log,
      err: new Error("Codec reclaimed due to inactivity"),
      outputFrameCount: 1,
      alreadyDowngraded: false,
      mediaId: "clip-xyz",
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/inactivity/i);
    expect(log.mock.calls[0]![0]).toMatch(/clip-xyz/);
  });

  test("downgrade warning records provenance but failed software is not retried", () => {
    const log = vi.fn();
    handleDecodeError({
      ...baseArgs,
      log,
      err: new Error("hw fail"),
      outputFrameCount: 0,
      alreadyDowngraded: false,
      retryMidstreamHardware: true,
    });
    handleDecodeError({
      ...baseArgs,
      log,
      err: new Error("mid-stream glitch"),
      outputFrameCount: 50,
      alreadyDowngraded: true,
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/retrying software.*outputs=0/);
  });
});

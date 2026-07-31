import { describe, expect, it } from "vitest";
import { ApiRouteError } from "@/lib/api/responses";
import {
  assertExecutorProtocol,
  EXECUTOR_PROTOCOL_HEADER,
  EXECUTOR_PROTOCOL_VERSION
} from "@/lib/runtime/executor-protocol";

describe("executor protocol", () => {
  it("accepts the current protocol version", () => {
    const request = new Request("http://localhost/api/executor/heartbeat", {
      headers: { [EXECUTOR_PROTOCOL_HEADER]: EXECUTOR_PROTOCOL_VERSION }
    });
    expect(() => assertExecutorProtocol(request)).not.toThrow();
  });

  it.each([undefined, "0"])("rejects a missing or outdated protocol: %s", (version) => {
    const headers = version ? { [EXECUTOR_PROTOCOL_HEADER]: version } : undefined;
    const request = new Request("http://localhost/api/executor/heartbeat", { headers });

    expect(() => assertExecutorProtocol(request)).toThrowError(ApiRouteError);
    try {
      assertExecutorProtocol(request);
    } catch (error) {
      expect(error).toMatchObject({ status: 426, code: "executor_protocol_mismatch" });
    }
  });
});

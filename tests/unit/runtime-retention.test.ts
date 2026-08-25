import { afterEach, describe, expect, it } from "vitest";
import { runtimeRetentionConfiguration } from "@/lib/runtime/retention";

const original = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in original)) delete process.env[key];
  }
  Object.assign(process.env, original);
});

describe("runtime retention configuration", () => {
  it("uses conservative defaults", () => {
    delete process.env.SCENECART_EVENT_RETENTION_DAYS;
    delete process.env.SCENECART_JOB_RETENTION_DAYS;
    expect(runtimeRetentionConfiguration()).toMatchObject({
      eventDays: 30,
      terminalJobDays: 90,
      archivedSessionDays: 365
    });
  });

  it("clamps unsafe retention values", () => {
    process.env.SCENECART_EVENT_RETENTION_DAYS = "1";
    process.env.SCENECART_JOB_RETENTION_DAYS = "99999";
    expect(runtimeRetentionConfiguration()).toMatchObject({
      eventDays: 7,
      terminalJobDays: 730
    });
  });
});

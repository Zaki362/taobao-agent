import { describe, expect, it } from "vitest";
import {
  DEFAULT_PUBLIC_DEMO_ORIGIN,
  buildPublicDemoAutoplayUrl,
  buildPublicDemoRootUrl,
  resolvePublicDemoOrigin
} from "@/lib/public-demo-url";

describe("public Demo URL", () => {
  it("uses the fixed public Demo domain by default", () => {
    expect(resolvePublicDemoOrigin()).toBe(DEFAULT_PUBLIC_DEMO_ORIGIN);
    expect(buildPublicDemoRootUrl()).toBe("https://scenecart-public-demo.vercel.app/");
    expect(buildPublicDemoAutoplayUrl()).toBe(
      "https://scenecart-public-demo.vercel.app/?autoplay=1"
    );
  });

  it("accepts an HTTPS deployment origin and normalizes the autoplay route", () => {
    expect(buildPublicDemoAutoplayUrl("https://demo.scenecart.example/")).toBe(
      "https://demo.scenecart.example/?autoplay=1"
    );
  });

  it("allows localhost HTTP only for local cross-app previews", () => {
    expect(buildPublicDemoAutoplayUrl("http://127.0.0.1:3262")).toBe(
      "http://127.0.0.1:3262/?autoplay=1"
    );
    expect(buildPublicDemoRootUrl("http://127.0.0.1:3262")).toBe("http://127.0.0.1:3262/");
  });

  it.each([
    "not-a-url",
    "http://public.example.com",
    "javascript:alert(1)",
    "https://user:secret@demo.example.com",
    "https://demo.example.com/unexpected-path",
    "https://demo.example.com/?autoplay=0"
  ])("falls back safely for an invalid configured origin: %s", (configuredUrl) => {
    expect(resolvePublicDemoOrigin(configuredUrl)).toBe(DEFAULT_PUBLIC_DEMO_ORIGIN);
  });
});

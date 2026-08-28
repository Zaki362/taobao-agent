import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

describe("dashboard persistence identity boundary", () => {
  it("uses a non-sensitive single-user scope instead of the fixed owner UUID", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "components", "use-dashboard-persistence.ts"),
      "utf8"
    );

    expect(source).toContain('payload.persistence_scope === "single_user"');
    expect(source).toContain('return "access:single_user"');
    expect(source).not.toContain("SCENECART_SINGLE_USER_ID");
  });
});

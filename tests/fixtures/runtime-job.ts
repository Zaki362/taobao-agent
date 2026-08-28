import { localRuntimeRepository } from "@/lib/runtime/local-repository";
import type { CreateRuntimeJobInput, RuntimeJob } from "@/lib/runtime/types";
import { createSessionFixture } from "@/tests/fixtures/session";

/**
 * Creates the owning Session fixture required by the strict runtime Job boundary.
 * Existing Sessions are intentionally left untouched so owner mismatch coverage
 * still exercises the production repository invariant.
 */
export async function createRuntimeJobFixture(input: CreateRuntimeJobInput): Promise<RuntimeJob> {
  const existing = await localRuntimeRepository.getSession(input.session_id);
  if (!existing) {
    await localRuntimeRepository.saveSession(createSessionFixture({
      session_id: input.session_id,
      owner_id: input.user_id
    }));
  }
  return localRuntimeRepository.createJob(input);
}

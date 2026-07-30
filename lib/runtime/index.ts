import { isPostgresRuntimeEnabled } from "@/lib/runtime/database";
import { localRuntimeRepository } from "@/lib/runtime/local-repository";
import { postgresRuntimeRepository } from "@/lib/runtime/postgres-repository";

export function getRuntimeRepository() {
  return isPostgresRuntimeEnabled() ? postgresRuntimeRepository : localRuntimeRepository;
}

export function runtimeStoreMode() {
  return isPostgresRuntimeEnabled() ? "postgres" as const : "local" as const;
}

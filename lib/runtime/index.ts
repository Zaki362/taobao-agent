import { isPostgresRuntimeEnabled } from "@/lib/runtime/database";
import { localRuntimeRepository } from "@/lib/runtime/local-repository";
import { postgresRuntimeRepository } from "@/lib/runtime/postgres-repository";
import { isFormalProductMode } from "@/lib/runtime/product-mode";

export function assertRuntimeRepositoryConfiguration() {
  if (!isFormalProductMode()) return;
  if (!isPostgresRuntimeEnabled()) {
    throw new Error("正式产品模式拒绝使用本地运行时；请配置 RUNTIME_STORE=postgres 和 DATABASE_URL。");
  }
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error("正式产品模式缺少 DATABASE_URL，无法安全读写用户会话和任务。");
  }
}

export function getRuntimeRepository() {
  assertRuntimeRepositoryConfiguration();
  return isPostgresRuntimeEnabled() ? postgresRuntimeRepository : localRuntimeRepository;
}

export function runtimeStoreMode() {
  return isPostgresRuntimeEnabled() ? "postgres" as const : "local" as const;
}

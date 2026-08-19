import { randomUUID } from "node:crypto";
import {
  createOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  isValidEmail,
  normalizeEmail,
  validatePassword,
  verifyPassword
} from "@/lib/auth/crypto";
import { getRuntimeRepository } from "@/lib/runtime";
import { ApiRouteError } from "@/lib/api/responses";

const DEFAULT_SESSION_DAYS = 30;
export const AUTH_SESSION_TOUCH_INTERVAL_MS = 10 * 60 * 1000;

function sessionTtlMs() {
  const days = Number(process.env.AUTH_SESSION_TTL_DAYS ?? DEFAULT_SESSION_DAYS);
  return Math.max(1, Math.min(days, 90)) * 24 * 60 * 60 * 1000;
}

export async function registerUser(emailInput: string, password: string) {
  const email = normalizeEmail(emailInput);
  if (!isValidEmail(email)) throw new ApiRouteError("请输入有效邮箱地址", 400, "invalid_email");
  const passwordError = validatePassword(password);
  if (passwordError) throw new ApiRouteError(passwordError, 400, "invalid_password");

  const repository = getRuntimeRepository();
  if (await repository.findUserByEmail(email)) {
    throw new ApiRouteError("该邮箱已经注册", 409, "email_already_registered");
  }
  const now = new Date().toISOString();
  let user;
  try {
    user = await repository.createUser({
      id: randomUUID(),
      email,
      password_hash: await hashPassword(password),
      created_at: now,
      updated_at: now
    });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
    if (code === "23505" || (error instanceof Error && /already registered/i.test(error.message))) {
      throw new ApiRouteError("该邮箱已经注册", 409, "email_already_registered");
    }
    throw error;
  }
  const session = await issueAuthSession(user.id);
  return { user, ...session };
}

export async function loginUser(emailInput: string, password: string) {
  const email = normalizeEmail(emailInput);
  const repository = getRuntimeRepository();
  const user = await repository.findUserByEmail(email);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    throw new ApiRouteError("邮箱或密码不正确", 401, "invalid_credentials");
  }
  const session = await issueAuthSession(user.id);
  return { user, ...session };
}

async function issueAuthSession(userId: string) {
  const repository = getRuntimeRepository();
  const token = createOpaqueToken();
  const now = Date.now();
  const expiresAt = new Date(now + sessionTtlMs()).toISOString();
  await repository.createAuthSession({
    id: randomUUID(),
    user_id: userId,
    token_hash: hashOpaqueToken(token),
    expires_at: expiresAt,
    created_at: new Date(now).toISOString(),
    last_seen_at: new Date(now).toISOString()
  });
  return { token, expiresAt };
}

export async function authenticateToken(token: string) {
  const repository = getRuntimeRepository();
  const tokenHash = hashOpaqueToken(token);
  const session = await repository.findAuthSession(tokenHash);
  if (!session) return null;
  const user = await repository.findUserById(session.user_id);
  if (!user) return null;
  const lastSeenAt = Date.parse(session.last_seen_at);
  if (!Number.isFinite(lastSeenAt) || Date.now() - lastSeenAt >= AUTH_SESSION_TOUCH_INTERVAL_MS) {
    await repository.touchAuthSession(tokenHash, AUTH_SESSION_TOUCH_INTERVAL_MS);
  }
  return { user, session };
}

export async function logoutToken(token: string) {
  await getRuntimeRepository().deleteAuthSession(hashOpaqueToken(token));
}

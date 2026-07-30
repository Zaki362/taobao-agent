"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function AuthForm() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "登录失败");
      router.push("/");
      router.refresh();
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="section-card w-full max-w-md">
      <CardHeader>
        <CardTitle>{mode === "login" ? "登录 SceneCart AI" : "创建 SceneCart AI 账号"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <label className="block text-sm font-medium">
            邮箱
            <input
              className="mt-2 h-12 w-full rounded-[16px] border border-border bg-white px-4 outline-none focus:border-primary"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label className="block text-sm font-medium">
            密码
            <input
              className="mt-2 h-12 w-full rounded-[16px] border border-border bg-white px-4 outline-none focus:border-primary"
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={8}
              required
            />
          </label>
          {error ? <p className="rounded-[16px] bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p> : null}
          <Button className="w-full" disabled={busy} type="submit">
            {busy ? "正在处理" : mode === "login" ? "登录" : "注册并登录"}
          </Button>
          <button
            type="button"
            className="w-full text-sm text-muted-foreground hover:text-foreground"
            onClick={() => setMode(mode === "login" ? "register" : "login")}
          >
            {mode === "login" ? "还没有账号？创建账号" : "已有账号？返回登录"}
          </button>
        </form>
      </CardContent>
    </Card>
  );
}

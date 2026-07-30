"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Device = {
  id: string;
  name: string;
  status: string;
  capabilities: string[];
  last_heartbeat_at?: string;
};

function deviceStatus(device: Device) {
  if (device.status === "revoked") return "已撤销";
  const heartbeat = device.last_heartbeat_at ? Date.parse(device.last_heartbeat_at) : 0;
  return heartbeat && Date.now() - heartbeat < 45_000 ? "在线" : "离线";
}

export function ExecutorSettings() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [apiUrl, setApiUrl] = useState("http://127.0.0.1:3000");

  async function load() {
    const response = await fetch("/api/executor/devices");
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "读取执行器失败");
    setDevices(payload.devices || []);
  }

  useEffect(() => {
    setApiUrl(window.location.origin);
    load().catch((value) => setError(value instanceof Error ? value.message : "读取执行器失败"));
  }, []);

  async function register() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/executor/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "这台 Mac 的淘宝执行器" })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "注册执行器失败");
      setToken(payload.device_token);
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : "注册执行器失败");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(deviceId: string) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/executor/devices", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_id: deviceId })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "撤销执行器失败");
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : "撤销执行器失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card className="hero-card">
        <CardContent className="px-6 py-7 md:px-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="label-text">Local Executor</p>
            <a href="/?resume=1" className="text-sm font-medium text-primary hover:underline">返回当前购物进度</a>
          </div>
          <h1 className="mt-3 text-3xl font-semibold">连接这台电脑上的 Qoder 与淘宝</h1>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-muted-foreground">
            网页只负责任务规划和状态展示；真实淘宝操作由本地执行器领取持久化任务后完成。设备令牌只在注册时展示一次。
          </p>
        </CardContent>
      </Card>

      <Card className="section-card">
        <CardHeader><CardTitle>执行器设备</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {devices.map((device) => (
            <div key={device.id} className="subtle-card flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p className="font-medium">{device.name}</p>
                <p className="mt-1 text-xs text-muted-foreground">{device.capabilities.join("、")} · {deviceStatus(device)}</p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-xs text-muted-foreground">最近心跳：{device.last_heartbeat_at ? new Date(device.last_heartbeat_at).toLocaleString("zh-CN", { hour12: false }) : "尚未连接"}</p>
                {device.status !== "revoked" ? (
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => revoke(device.id)}>
                    撤销令牌
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
          {devices.length === 0 ? <p className="text-sm text-muted-foreground">还没有已注册设备。</p> : null}
          <Button onClick={register} disabled={busy}>{busy ? "正在注册" : "注册当前设备"}</Button>
          {error ? <p className="rounded-[16px] bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p> : null}
        </CardContent>
      </Card>

      <Card className="section-card">
        <CardHeader><CardTitle>连接检查</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm leading-7 text-muted-foreground">
          <p>Doctor 只检查网页服务、设备令牌和 Qoder CLI，不会主动打开淘宝商品页，也不会触发加购。</p>
          <pre className="overflow-x-auto rounded-[18px] bg-foreground p-4 text-xs leading-6 text-white">{`SCENECART_API_URL='${apiUrl}' SCENECART_DEVICE_TOKEN='你的设备令牌' npm run executor:doctor`}</pre>
          <p>三个检查均显示 PASS 后再启动执行器。淘宝 skill 会在第一条由用户确认的搜索任务中完成真实验证。</p>
        </CardContent>
      </Card>

      {token ? (
        <Card className="section-card border-primary/20">
          <CardHeader><CardTitle>启动命令</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">请在项目终端执行。关闭页面后无法再次查看该令牌。</p>
            <pre className="overflow-x-auto rounded-[18px] bg-foreground p-4 text-xs leading-6 text-white">{`SCENECART_API_URL='${apiUrl}' SCENECART_DEVICE_TOKEN='${token}' npm run executor:doctor\nSCENECART_API_URL='${apiUrl}' SCENECART_DEVICE_TOKEN='${token}' npm run worker:local`}</pre>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

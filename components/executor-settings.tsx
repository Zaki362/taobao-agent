"use client";

import { useEffect, useState } from "react";
import { Check, Copy, RefreshCw, ShieldCheck, Terminal, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Device = {
  id: string;
  name: string;
  status: string;
  capabilities: string[];
  last_heartbeat_at?: string;
};

type DeviceAuditEvent = {
  id: number;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
};

type ReadinessCheck = {
  id: string;
  label: string;
  status: "pass" | "fail" | "warn";
  required: boolean;
  detail: string;
  remediation?: string;
};

type Readiness = {
  product_mode: "development" | "production";
  demo_cart_fallback: boolean;
  ready_for_production: boolean;
  operational_for_shopping: boolean;
  executor_capabilities: {
    registered: number;
    online: number;
    capabilities: {
      module_search: { registered: number; online: number; available: boolean };
      add_to_cart: { registered: number; online: number; available: boolean };
    };
  };
  checks: ReadinessCheck[];
};

function capabilityLabel(capability: string) {
  if (capability === "module_search") return "商品搜索";
  if (capability === "add_to_cart") return "真实加购";
  return capability;
}

function deviceStatus(device: Device) {
  if (device.status === "revoked") return "已撤销";
  const heartbeat = device.last_heartbeat_at ? Date.parse(device.last_heartbeat_at) : 0;
  return heartbeat && Date.now() - heartbeat < 45_000 ? "在线" : "离线";
}

export function ExecutorSettings() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [auditEvents, setAuditEvents] = useState<DeviceAuditEvent[]>([]);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [apiUrl, setApiUrl] = useState("http://127.0.0.1:3000");
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [copied, setCopied] = useState("");
  const [lastCheckedAt, setLastCheckedAt] = useState("");
  const [enableCartCapability, setEnableCartCapability] = useState(false);

  const activeDevices = devices.filter((device) => device.status !== "revoked");
  const onlineDevices = activeDevices.filter((device) => deviceStatus(device) === "在线");
  const searchAvailable = readiness?.executor_capabilities.capabilities.module_search.available ?? false;
  const cartAvailable = readiness?.executor_capabilities.capabilities.add_to_cart.available ?? false;
  const doctorCommand = `SCENECART_API_URL='${apiUrl}' SCENECART_DEVICE_TOKEN='${token || "你的设备令牌"}' npm run executor:doctor`;
  const workerCommand = `SCENECART_API_URL='${apiUrl}' SCENECART_DEVICE_TOKEN='${token || "你的设备令牌"}' npm run worker:local`;

  async function load() {
    const [devicesResponse, readinessResponse] = await Promise.all([
      fetch("/api/executor/devices"),
      fetch("/api/runtime/readiness")
    ]);
    const devicesPayload = await devicesResponse.json().catch(() => ({}));
    const readinessPayload = await readinessResponse.json().catch(() => ({}));
    if (!devicesResponse.ok) throw new Error(devicesPayload.error || "读取执行器失败");
    if (!readinessResponse.ok) throw new Error(readinessPayload.error || "读取发布就绪状态失败");
    setDevices(devicesPayload.devices || []);
    setAuditEvents(devicesPayload.audit_events || []);
    setReadiness(readinessPayload as Readiness);
    setLastCheckedAt(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
  }

  useEffect(() => {
    setApiUrl(window.location.origin);
    load().catch((value) => setError(value instanceof Error ? value.message : "读取执行器失败"));
    const timer = window.setInterval(() => {
      load().catch((value) => setError(value instanceof Error ? value.message : "刷新执行器状态失败"));
    }, 10_000);
    return () => window.clearInterval(timer);
  }, []);

  async function register() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/executor/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "这台 Mac 的淘宝执行器",
          capabilities: enableCartCapability ? ["module_search", "add_to_cart"] : ["module_search"]
        })
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

  async function setCartCapability(device: Device, enabled: boolean) {
    if (enabled && !window.confirm("开启后，这台设备可以领取你在产品中显式确认的真实淘宝加购任务。确定继续吗？")) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/executor/devices", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_id: device.id,
          capabilities: enabled ? ["module_search", "add_to_cart"] : ["module_search"]
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "更新执行器权限失败");
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : "更新执行器权限失败");
    } finally {
      setBusy(false);
    }
  }

  async function copyCommand(value: string, label: string) {
    setError("");
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      window.setTimeout(() => setCopied((current) => current === label ? "" : current), 1800);
    } catch {
      setError("浏览器未允许复制，请手动选择命令文本。");
    }
  }

  const setupSteps = [
    {
      title: "登录 Qoder CLI",
      detail: "在本机运行 qodercli，并输入 /login。登录态只保留在你的电脑上。",
      status: onlineDevices.length > 0 ? "done" as const : "manual" as const,
      icon: Terminal
    },
    {
      title: "注册执行设备",
      detail: "生成仅属于当前账号和这台电脑的一次性设备令牌。",
      status: activeDevices.length > 0 ? "done" as const : "pending" as const,
      icon: ShieldCheck
    },
    {
      title: "通过连接检查",
      detail: "Doctor 会检查 Qoder 登录、网页服务和设备令牌，不会操作淘宝。",
      status: onlineDevices.length > 0 ? "done" as const : "manual" as const,
      icon: Check
    },
    {
      title: "保持执行器在线",
      detail: "启动本地 Worker 后，搜索和加购任务会在后台执行并自动回填。",
      status: onlineDevices.length > 0 ? "done" as const : "pending" as const,
      icon: Wifi
    }
  ];

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
          <div className="mt-5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className={`rounded-full px-3 py-1.5 font-semibold ${readiness?.product_mode === "production" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-700"}`}>
              {!readiness ? "正在读取产品模式" : readiness.product_mode === "production" ? "正式产品模式" : "开发预览模式"}
            </span>
            <span className={`rounded-full px-3 py-1.5 font-semibold ${onlineDevices.length ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
              {onlineDevices.length ? `${onlineDevices.length} 台设备在线` : "等待本地执行器"}
            </span>
            <span className={`rounded-full px-3 py-1.5 font-semibold ${searchAvailable ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
              {searchAvailable ? "真实搜索可用" : "搜索能力未连接"}
            </span>
            <span className={`rounded-full px-3 py-1.5 font-semibold ${cartAvailable ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
              {cartAvailable ? "真实加购可用" : "加购能力未连接"}
            </span>
            <span>{!readiness ? "正在读取加购策略" : readiness.demo_cart_fallback ? "允许演示加购回退" : "仅接受真实加购结果"}</span>
            <span>{activeDevices.length} 台有效设备</span>
            {lastCheckedAt ? <span>最近检测 {lastCheckedAt}</span> : null}
          </div>
        </CardContent>
      </Card>

      <Card className="section-card">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>四步完成连接</CardTitle>
              <p className="mt-2 text-sm text-muted-foreground">网页不会读取淘宝账号信息，也不能绕过本机登录和授权。</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => load().catch((value) => setError(value instanceof Error ? value.message : "刷新失败"))}
            >
              <RefreshCw className="mr-2 h-4 w-4" />重新检测
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-2">
            {setupSteps.map((step, index) => {
              const Icon = step.icon;
              const completed = step.status === "done";
              const manual = step.status === "manual";
              return (
                <div key={step.title} className={`rounded-[20px] border p-4 ${completed ? "border-emerald-200 bg-emerald-50/55" : manual ? "border-amber-200 bg-amber-50/45" : "border-border bg-white"}`}>
                  <div className="flex items-start gap-3">
                    <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${completed ? "bg-emerald-600 text-white" : manual ? "bg-amber-100 text-amber-700" : "bg-secondary text-muted-foreground"}`}>
                      {completed ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold">{index + 1}. {step.title}</p>
                        {manual ? <span className="rounded-full bg-white/80 px-2 py-0.5 text-[11px] font-semibold text-amber-700">需在本机确认</span> : null}
                      </div>
                      <p className="mt-1 text-sm leading-6 text-muted-foreground">{step.detail}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card className="section-card">
        <CardHeader><CardTitle>设备权限审计</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {auditEvents.length ? auditEvents.slice(0, 8).map((event) => {
            const eventLabel = event.event_type === "executor.device_registered"
              ? "注册执行器"
              : event.event_type === "executor.device_revoked"
                ? "撤销执行器"
                : "更新执行权限";
            const deviceName = typeof event.payload.device_name === "string" ? event.payload.device_name : "本地执行器";
            const added = Array.isArray(event.payload.added) ? event.payload.added.map(String) : [];
            const removed = Array.isArray(event.payload.removed) ? event.payload.removed.map(String) : [];
            const changeSummary = added.length || removed.length
              ? `${added.length ? `新增 ${added.map(capabilityLabel).join("、")}` : ""}${added.length && removed.length ? "；" : ""}${removed.length ? `移除 ${removed.map(capabilityLabel).join("、")}` : ""}`
              : "权限状态已记录";
            return (
              <div key={event.id} className="subtle-card flex flex-wrap items-start justify-between gap-3 p-4">
                <div>
                  <p className="font-medium">{eventLabel} · {deviceName}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{changeSummary}</p>
                </div>
                <p className="text-xs text-muted-foreground">{new Date(event.created_at).toLocaleString("zh-CN", { hour12: false })}</p>
              </div>
            );
          }) : <p className="text-sm text-muted-foreground">还没有设备权限变更记录。</p>}
        </CardContent>
      </Card>

      <Card className="section-card">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>正式运行就绪度</CardTitle>
            <span className={`rounded-full px-3 py-1 text-xs font-semibold ${
              readiness?.operational_for_shopping
                ? "bg-emerald-50 text-emerald-700"
                : readiness?.ready_for_production
                  ? "bg-amber-50 text-amber-700"
                  : "bg-red-50 text-red-700"
            }`}>
              {readiness?.operational_for_shopping
                ? "可执行真实购物任务"
                : readiness?.ready_for_production
                  ? "服务已就绪，等待执行器"
                  : "仍有正式配置未完成"}
            </span>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-2">
            {(readiness?.checks ?? []).map((item) => (
              <div key={item.id} className="subtle-card p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-medium">{item.label}</p>
                  <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                    item.status === "pass"
                      ? "bg-emerald-50 text-emerald-700"
                      : item.status === "warn"
                        ? "bg-amber-50 text-amber-700"
                        : "bg-red-50 text-red-700"
                  }`}>
                    {item.status === "pass" ? "通过" : item.status === "warn" ? "待连接" : "未通过"}
                  </span>
                </div>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.detail}</p>
                {item.status !== "pass" && item.remediation ? (
                  <p className="mt-2 text-xs leading-5 text-foreground/70">下一步：{item.remediation}</p>
                ) : null}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="section-card">
        <CardHeader><CardTitle>执行器设备</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {devices.map((device) => (
            <div key={device.id} className="subtle-card flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p className="font-medium">{device.name}</p>
                <p className="mt-1 text-xs text-muted-foreground">{device.capabilities.map(capabilityLabel).join("、")} · {deviceStatus(device)}</p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-xs text-muted-foreground">最近心跳：{device.last_heartbeat_at ? new Date(device.last_heartbeat_at).toLocaleString("zh-CN", { hour12: false }) : "尚未连接"}</p>
                {device.status !== "revoked" ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => setCartCapability(device, !device.capabilities.includes("add_to_cart"))}
                    >
                      {device.capabilities.includes("add_to_cart") ? "关闭真实加购" : "开启真实加购"}
                    </Button>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => revoke(device.id)}>
                      撤销令牌
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
          ))}
          {devices.length === 0 ? <p className="text-sm text-muted-foreground">还没有已注册设备。</p> : null}
          <label className="flex items-start gap-3 rounded-[18px] border border-border/80 bg-white px-4 py-3 text-sm">
            <input
              type="checkbox"
              checked={enableCartCapability}
              onChange={(event) => setEnableCartCapability(event.target.checked)}
              className="mt-1 h-4 w-4 rounded border-border accent-primary"
            />
            <span>
              <span className="font-medium text-foreground">允许这台设备执行真实加购</span>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                默认只授予商品搜索。开启后仍会在每次加购前要求用户显式确认，不包含下单或付款权限。
              </span>
            </span>
          </label>
          <Button onClick={register} disabled={busy}>{busy ? "正在注册" : "注册当前设备"}</Button>
          {error ? <p className="rounded-[16px] bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p> : null}
        </CardContent>
      </Card>

      <Card className="section-card">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>连接检查</CardTitle>
            <Button variant="outline" size="sm" onClick={() => copyCommand(doctorCommand, "doctor")}>
              <Copy className="mr-2 h-4 w-4" />{copied === "doctor" ? "已复制" : "复制诊断命令"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-7 text-muted-foreground">
          <p>Doctor 只检查网页服务、设备令牌和 Qoder CLI，不会主动打开淘宝商品页，也不会触发加购。</p>
          <pre className="overflow-x-auto rounded-[18px] bg-foreground p-4 text-xs leading-6 text-white">{doctorCommand}</pre>
          <p>全部检查均显示 PASS 后再启动执行器。如果提示未登录，请先运行 <code>qodercli</code> 并输入 <code>/login</code>；淘宝 skill 会在第一条由用户确认的搜索任务中完成真实验证。</p>
        </CardContent>
      </Card>

      {token ? (
        <Card className="section-card border-primary/20">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>启动命令</CardTitle>
              <Button variant="outline" size="sm" onClick={() => copyCommand(workerCommand, "worker")}>
                <Copy className="mr-2 h-4 w-4" />{copied === "worker" ? "已复制" : "复制启动命令"}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">请在项目终端执行。关闭页面后无法再次查看该令牌。</p>
            <pre className="overflow-x-auto rounded-[18px] bg-foreground p-4 text-xs leading-6 text-white">{`${doctorCommand}\n${workerCommand}`}</pre>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

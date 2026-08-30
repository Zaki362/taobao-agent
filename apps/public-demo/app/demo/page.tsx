import { ClientRedirect } from "@/components/client-redirect";

export const dynamic = "force-static";

export default function PublicDemoPage() {
  return <ClientRedirect pathname="/" label="正在打开场景购公开 Demo…" />;
}

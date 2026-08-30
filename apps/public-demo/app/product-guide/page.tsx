import { ClientRedirect } from "@/components/client-redirect";

export default function PublicProductGuidePage() {
  return (
    <ClientRedirect
      pathname="/"
      query={{ guide: "1" }}
      label="正在打开场景购产品说明…"
    />
  );
}

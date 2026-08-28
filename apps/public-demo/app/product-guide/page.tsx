import { ClientRedirect } from "@/components/client-redirect";

export default function PublicProductGuidePage() {
  return (
    <ClientRedirect
      pathname="/"
      query={{ guide: "1" }}
      label="正在打开 SceneCart 产品说明…"
    />
  );
}

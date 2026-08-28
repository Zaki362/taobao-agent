import type { Route } from "next";
import { redirect } from "next/navigation";
import { PUBLIC_DEMO_ROOT_URL } from "@/lib/public-demo-url";

export default function PublicDemoRedirectPage() {
  redirect(PUBLIC_DEMO_ROOT_URL as Route);
}

import { CONFIG } from "@/lib/config";
import ClientDashboard from "@/components/ClientDashboard";
import type { Phase3Config } from "@/lib/phase3/types";

export default function Home() {
  const config = JSON.parse(JSON.stringify(CONFIG)) as Phase3Config;
  return <ClientDashboard config={config} />;
}

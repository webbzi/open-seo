import { NavTab, NavTabs } from "@/client/components/NavTabs";
import { isHostedClientAuthMode } from "@/lib/auth-mode";

const tabs = [
  { to: "/p/$projectId/settings" as const, label: "General", exact: true },
  { to: "/p/$projectId/settings/integrations" as const, label: "Integrations" },
  // Hosted deployments bill through credits; the per-project DataForSEO
  // ledger only exists on self-hosted ones.
  ...(isHostedClientAuthMode()
    ? []
    : [
        {
          to: "/p/$projectId/settings/api-spending" as const,
          label: "API spending",
        },
      ]),
];

export function SettingsTabs({ projectId }: { projectId: string }) {
  return (
    <NavTabs label="Project settings sections">
      {tabs.map((tab) => (
        <NavTab
          key={tab.to}
          to={tab.to}
          params={{ projectId }}
          activeOptions={{ exact: tab.exact ?? false }}
        >
          {tab.label}
        </NavTab>
      ))}
    </NavTabs>
  );
}

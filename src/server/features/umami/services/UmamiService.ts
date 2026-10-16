import {
  getUmamiConfig,
  listWebsites as listUmamiWebsites,
  type UmamiConfig,
} from "@/server/lib/umamiClient";
import { UmamiError } from "@/server/lib/umamiErrors";
import {
  UmamiConnectionRepository,
  type UmamiConnection,
} from "@/server/features/umami/repositories/UmamiConnectionRepository";

type ProjectScope = { projectId: string; organizationId: string };

async function requireConfig(): Promise<UmamiConfig> {
  const config = await getUmamiConfig();
  if (!config) {
    throw new UmamiError(
      "umami_not_configured",
      "Umami is not configured on this deployment.",
    );
  }
  return config;
}

/** The canonical IANA name, or null. `Intl` also accepts UTC offsets such as
 *  "+02:00", which are not IANA zones and break across DST, so those fail. */
function canonicalTimeZone(value: string): string | null {
  if (!/^[A-Za-z]/.test(value)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: value,
    }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** Reads only the database and deployment config: no Umami request. */
async function getStatus(scope: ProjectScope) {
  const [config, connection] = await Promise.all([
    getUmamiConfig(),
    UmamiConnectionRepository.getByProjectId(scope),
  ]);
  return {
    configured: config !== null,
    connected: connection !== null,
    websiteId: connection?.websiteId ?? null,
    websiteName: connection?.websiteName ?? null,
    websiteDomain: connection?.websiteDomain ?? null,
    timeZone: connection?.timeZone ?? null,
  };
}

async function listWebsites() {
  return listUmamiWebsites(await requireConfig());
}

/** The client chooses only the website and time zone. The website must be in
 *  a fresh discovery, which also supplies the stored name and domain. */
async function setWebsite(
  input: ProjectScope & { websiteId: string; timeZone: string },
): Promise<UmamiConnection> {
  const timeZone = canonicalTimeZone(input.timeZone);
  if (!timeZone) {
    throw new UmamiError("validation_error", "Invalid IANA time zone.");
  }
  const websites = await listUmamiWebsites(await requireConfig());
  const website = websites.find(({ id }) => id === input.websiteId);
  if (!website) {
    throw new UmamiError(
      "umami_website_not_found",
      "That website isn't available to this deployment's Umami API key.",
    );
  }
  return UmamiConnectionRepository.upsert({
    projectId: input.projectId,
    organizationId: input.organizationId,
    websiteId: website.id,
    websiteName: website.name,
    websiteDomain: website.domain,
    timeZone,
  });
}

async function disconnect(scope: ProjectScope): Promise<void> {
  await UmamiConnectionRepository.deleteByProjectId(scope);
}

export const UmamiService = {
  getStatus,
  listWebsites,
  setWebsite,
  disconnect,
};

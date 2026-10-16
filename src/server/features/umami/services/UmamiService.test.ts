import { beforeEach, describe, expect, it, vi } from "vitest";
import { UmamiService } from "./UmamiService";

// Real in-memory SQLite with every production migration, so the upsert's
// conflict path and the organization scoping run as production SQL. Only the
// Umami HTTP client is mocked.

const testDb = await vi.hoisted(async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  const { sort } = await import("remeda");
  const client = createClient({ url: "file::memory:" });
  const migrations = sort(
    readdirSync("drizzle/sqlite").filter((file) => file.endsWith(".sql")),
    (a, b) => a.localeCompare(b),
  );
  for (const file of migrations)
    await client.executeMultiple(
      readFileSync(`drizzle/sqlite/${file}`, "utf8").replaceAll(
        "--> statement-breakpoint",
        "",
      ),
    );
  return { client, db: drizzle(client) };
});

const mocks = vi.hoisted(() => ({
  getUmamiConfig: vi.fn(),
  listWebsites: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/server/lib/umamiClient", () => mocks);

const scope = { projectId: "project", organizationId: "organization" };
const siteA = {
  id: "00000000-0000-4000-8000-00000000000a",
  name: "Site A",
  domain: "a.com",
};
const siteB = {
  id: "00000000-0000-4000-8000-00000000000b",
  name: "Site B",
  domain: null,
};

beforeEach(async () => {
  mocks.getUmamiConfig.mockResolvedValue({
    baseUrl: "https://umami.example.com",
    apiKey: "umami_key",
  });
  mocks.listWebsites.mockResolvedValue([siteA, siteB]);
  await testDb.client.executeMultiple(`
    DELETE FROM organization;
    INSERT INTO organization (id, name, slug, created_at) VALUES
      ('organization', 'Agency', 'agency', 0),
      ('other', 'Other', 'other', 0);
    INSERT INTO projects (id, organization_id, name) VALUES
      ('project', 'organization', 'Client A');
  `);
});

describe("UmamiService", () => {
  it("stores the discovered website's name and domain, then replaces them on change", async () => {
    await UmamiService.setWebsite({
      ...scope,
      websiteId: siteA.id,
      timeZone: "europe/madrid",
    });
    await expect(UmamiService.getStatus(scope)).resolves.toEqual({
      configured: true,
      connected: true,
      websiteId: siteA.id,
      websiteName: "Site A",
      websiteDomain: "a.com",
      timeZone: "Europe/Madrid",
    });

    await UmamiService.setWebsite({
      ...scope,
      websiteId: siteB.id,
      timeZone: "UTC",
    });
    await expect(UmamiService.getStatus(scope)).resolves.toMatchObject({
      websiteId: siteB.id,
      websiteName: "Site B",
      websiteDomain: null,
      timeZone: "UTC",
    });
  });

  it("rejects a website missing from a fresh discovery", async () => {
    mocks.listWebsites.mockResolvedValue([siteB]);

    await expect(
      UmamiService.setWebsite({
        ...scope,
        websiteId: siteA.id,
        timeZone: "UTC",
      }),
    ).rejects.toMatchObject({ code: "umami_website_not_found" });
    await expect(UmamiService.getStatus(scope)).resolves.toMatchObject({
      connected: false,
    });
  });

  it.each(["Mars/Olympus_Mons", "+02:00"])(
    "rejects the non-IANA time zone %s",
    async (timeZone) => {
      await expect(
        UmamiService.setWebsite({ ...scope, websiteId: siteA.id, timeZone }),
      ).rejects.toMatchObject({ code: "validation_error" });
    },
  );

  it("keeps another organization's request away from the project's mapping", async () => {
    await UmamiService.setWebsite({
      ...scope,
      websiteId: siteA.id,
      timeZone: "UTC",
    });
    const foreign = { projectId: "project", organizationId: "other" };

    await expect(
      UmamiService.setWebsite({
        ...foreign,
        websiteId: siteB.id,
        timeZone: "UTC",
      }),
    ).rejects.toThrow("Failed to upsert umami_connection");
    await UmamiService.disconnect(foreign);

    await expect(UmamiService.getStatus(foreign)).resolves.toMatchObject({
      connected: false,
    });
    await expect(UmamiService.getStatus(scope)).resolves.toMatchObject({
      websiteId: siteA.id,
    });
  });

  it("refuses to list websites when Umami is not configured", async () => {
    mocks.getUmamiConfig.mockResolvedValue(null);

    await expect(UmamiService.listWebsites()).rejects.toMatchObject({
      code: "umami_not_configured",
    });
    expect(mocks.listWebsites).not.toHaveBeenCalled();
  });
});

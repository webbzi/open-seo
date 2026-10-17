import { createServerFn } from "@tanstack/react-start";
import { waitUntil } from "cloudflare:workers";
import { z } from "zod";
import { UmamiService } from "@/server/features/umami/services/UmamiService";
import { UmamiReportService } from "@/server/features/umami/services/UmamiReportService";
import { AppError } from "@/server/lib/errors";
import { UmamiError } from "@/server/lib/umamiErrors";
import { hasOrgPermission } from "@/lib/org-permissions";
import { requireOrgPermission } from "@/server/auth/org-gate";
import { captureServerEvent } from "@/server/lib/posthog";
import { requireProjectContext } from "@/serverFunctions/middleware";
import type { ErrorCode } from "@/shared/error-codes";

const projectScopedSchema = z.object({ projectId: z.string().min(1) });
const setWebsiteSchema = projectScopedSchema.extend({
  websiteId: z.guid(),
  timeZone: z.string().min(1).max(100),
});

const APP_ERROR_CODE = {
  umami_unauthorized: "UMAMI_AUTH_FAILED",
  umami_website_not_found: "NOT_FOUND",
  umami_rate_limited: "RATE_LIMITED",
  umami_upstream_unavailable: "UPSTREAM_UNAVAILABLE",
  // A request OpenSEO built or a response it can't read: our fault or an
  // unsupported Umami version, never the user's.
  umami_bad_request: "INTERNAL_ERROR",
  umami_malformed_response: "INTERNAL_ERROR",
  umami_not_configured: "NOT_FOUND",
  umami_not_connected: "NOT_FOUND",
  validation_error: "VALIDATION_ERROR",
} as const satisfies Record<UmamiError["code"], ErrorCode>;

/** The client sees only the AppError code; the Umami message stays in the
 *  server logs. */
async function withUmamiErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof UmamiError)) throw error;
    console.warn("umami.request_failed", {
      code: error.code,
      message: error.message,
    });
    throw new AppError(APP_ERROR_CODE[error.code], error.message);
  }
}

export const getUmamiConnection = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => ({
    ...(await UmamiService.getStatus({
      projectId: context.projectId,
      organizationId: context.organizationId,
    })),
    canManage: hasOrgPermission(context.role, { integration: ["manage"] }),
  }));

const NOT_CONNECTED_CODES = [
  "umami_not_configured",
  "umami_not_connected",
  "umami_website_not_found",
  "umami_unauthorized",
] as const;
type NotConnectedCode = (typeof NOT_CONNECTED_CODES)[number];

function isNotConnectedCode(
  code: UmamiError["code"],
): code is NotConnectedCode {
  return (NOT_CONNECTED_CODES as readonly string[]).includes(code);
}

/** The dashboard's Umami card: totals vs the previous period over the default
 *  (last 28 complete days) range. */
export const getUmamiDashboardReport = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => {
    try {
      const report = await UmamiReportService.getOverview({
        projectId: context.projectId,
        organizationId: context.organizationId,
      });
      return { connected: true as const, report };
    } catch (error) {
      if (error instanceof UmamiError) {
        // Missing config, connection, website or access: the card explains
        // and links to Integrations instead of retrying a call that can't work.
        if (isNotConnectedCode(error.code)) {
          return { connected: false as const, reason: error.code };
        }
        throw new AppError(APP_ERROR_CODE[error.code], error.message);
      }
      throw error;
    }
  });

export const listUmamiWebsites = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => {
    requireOrgPermission(context, { integration: ["manage"] });
    return { websites: await withUmamiErrors(UmamiService.listWebsites) };
  });

export const setUmamiWebsite = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(setWebsiteSchema)
  .handler(async ({ data, context }) => {
    requireOrgPermission(context, { integration: ["manage"] });
    const connection = await withUmamiErrors(() =>
      UmamiService.setWebsite({
        projectId: context.projectId,
        organizationId: context.organizationId,
        websiteId: data.websiteId,
        timeZone: data.timeZone,
      }),
    );
    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "umami:website_select",
        organizationId: context.organizationId,
        properties: { project_id: context.projectId },
      }),
    );
    return {
      websiteId: connection.websiteId,
      websiteName: connection.websiteName,
      websiteDomain: connection.websiteDomain,
      timeZone: connection.timeZone,
    };
  });

export const disconnectUmami = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => {
    requireOrgPermission(context, { integration: ["manage"] });
    await UmamiService.disconnect({
      projectId: context.projectId,
      organizationId: context.organizationId,
    });
    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "umami:disconnect",
        organizationId: context.organizationId,
        properties: { project_id: context.projectId },
      }),
    );
    return { connected: false as const };
  });

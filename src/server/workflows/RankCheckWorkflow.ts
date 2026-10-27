import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { withPgClient } from "@/db";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { failRunIfActive } from "@/server/features/rank-tracking/services/rankCheckRunGuards";
import { projectDataforseoRefusal } from "@/server/features/projects/services/projectDataforseoPrecheck";
import {
  runLiveCheck,
  runQueuedCheck,
} from "@/server/workflows/rankCheckPaths";
import { retryRankChecks } from "@/server/workflows/rankCheckRetries";
import { pgStep } from "@/server/workflows/pgStep";
import {
  stepProjectRefusal,
  type ProjectRefusalCode,
} from "@/server/workflows/projectRefusal";
import {
  createDataforseoClient,
  type ProjectBillingCustomer,
} from "@/server/lib/dataforseo";
import { captureServerEvent } from "@/server/lib/posthog";
import { sendCreditsExhaustedEvent } from "@/server/email/onboarding-drip";
import { describeError } from "@/server/lib/errors";
import { autumn } from "@/server/billing/autumn";
import {
  AUTUMN_SEO_DATA_BALANCE_FEATURE_ID,
  AUTUMN_SEO_DATA_TOPUP_BALANCE_FEATURE_ID,
} from "@/shared/billing";
import {
  estimateRankCheckCredits,
  rankCheckCostApprovalError,
  type RankTrackingSkipReason,
} from "@/shared/rank-tracking";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import { isErrorCode } from "@/shared/error-codes";

// These steps cost nothing and are safe to repeat: they touch our own rows,
// prepare's Autumn calls only read balances, and its credits email is sent
// once a day. So an engine failure on one attempt does not fail the run. The
// paid batch steps live in rankCheckPaths and run once.
const FREE_STEP_CONFIG = {
  retries: { limit: 2, delay: "10 seconds" as const },
  timeout: "2 minutes" as const,
};

const PROJECT_REFUSAL_SKIP_REASONS = {
  PROJECT_BUDGET_EXCEEDED: "project_budget_exceeded",
  PROJECT_DATAFORSEO_PAUSED: "project_dataforseo_paused",
} as const satisfies Record<ProjectRefusalCode, RankTrackingSkipReason>;

interface RankCheckParams {
  runId: string;
  configId: string;
  billingCustomer: ProjectBillingCustomer;
  projectId: string;
  domain: string;
  locationCode: number;
  languageCode: string;
  locationName?: string;
  devices: "both" | "desktop" | "mobile";
  serpDepth: number;
  trigger: "manual" | "scheduled";
  keywordIds?: string[];
  maxCostCredits?: number;
}

async function prepareRankCheckKeywords(input: {
  runId: string;
  configId: string;
  billingCustomer: ProjectBillingCustomer;
  devices: RankCheckParams["devices"];
  serpDepth: number;
  trigger: RankCheckParams["trigger"];
  keywordIds?: string[];
  maxCostCredits?: number;
}) {
  // If stale-cleanup marked our run failed before we got here, bail out
  // rather than resurrecting a superseded run.
  const run = await RankTrackingRepository.getRunById(input.runId);
  if (!run || run.status === "failed" || run.status === "completed") {
    throw new NonRetryableError(
      `Run ${input.runId} is no longer active (status=${run?.status ?? "missing"})`,
    );
  }

  await RankTrackingRepository.updateRun(input.runId, {
    status: "running",
  });

  let trackingKeywords = await RankTrackingRepository.getKeywordsForConfig(
    input.configId,
  );

  if (input.keywordIds && input.keywordIds.length > 0) {
    const idSet = new Set(input.keywordIds);
    trackingKeywords = trackingKeywords.filter((kw) => idSet.has(kw.id));
  }

  // Refusals are not retried: a retry would only repeat them, and send the
  // credits email again.
  if (trackingKeywords.length === 0) {
    throw new NonRetryableError("No keywords to track");
  }

  const { costCredits } = estimateRankCheckCredits(
    trackingKeywords.map((kw) => kw.keyword),
    input.devices,
    input.serpDepth,
    input.trigger === "scheduled" ? "queued" : "live",
  );
  if (input.maxCostCredits != null && costCredits > input.maxCostCredits) {
    throw new NonRetryableError(
      rankCheckCostApprovalError(costCredits, input.maxCostCredits),
    );
  }

  // Verify the user has enough credits for the full check before starting.
  // Scheduled checks go through the cheaper task queue, so estimate at queued
  // pricing — a live-price estimate would skip checks the user can afford.
  // The estimate is the worst case, so it covers every retry.
  if (await isHostedServerAuthMode()) {
    const [monthlyCheck, topupCheck] = await Promise.all([
      autumn.check({
        customerId: input.billingCustomer.organizationId,
        featureId: AUTUMN_SEO_DATA_BALANCE_FEATURE_ID,
      }),
      autumn.check({
        customerId: input.billingCustomer.organizationId,
        featureId: AUTUMN_SEO_DATA_TOPUP_BALANCE_FEATURE_ID,
      }),
    ]);
    const available =
      (monthlyCheck.balance?.remaining ?? 0) +
      (topupCheck.balance?.remaining ?? 0);
    if (available < costCredits) {
      await sendCreditsExhaustedEvent(input.billingCustomer);
      // The code alone, so the run's saved error shows the credits card.
      throw new NonRetryableError("INSUFFICIENT_CREDITS");
    }
  } else {
    // Self-hosted: skip with the project's reason when its DataForSEO budget
    // would refuse every call anyway.
    const refusal = await projectDataforseoRefusal(
      input.billingCustomer.organizationId,
      input.billingCustomer.projectId,
    );
    // The code alone, as for credits above.
    if (refusal) throw new NonRetryableError(refusal.code);
  }

  await RankTrackingRepository.updateRun(input.runId, {
    keywordsTotal: trackingKeywords.length,
  });

  return {
    keywords: trackingKeywords.map((kw) => ({
      id: kw.id,
      keyword: kw.keyword,
    })),
  };
}

async function finalizeRankCheckRun(input: {
  runId: string;
  configId: string;
  projectId: string;
  billingCustomer: ProjectBillingCustomer;
  trigger: RankCheckParams["trigger"];
  devices: RankCheckParams["devices"];
  batchError: string | null;
  refusal: ProjectRefusalCode | null;
}) {
  // If stale-cleanup already marked our run failed, don't overwrite that
  // decision with a completed status — a replacement run may already be
  // underway.
  const run = await RankTrackingRepository.getRunById(input.runId);
  if (!run || run.status === "failed" || run.status === "completed") {
    console.warn(
      `[rank-check] ${input.runId} no longer active (status=${run?.status ?? "missing"}), skipping finalization`,
    );
    return;
  }

  const nowIso = new Date().toISOString();

  // Snapshots were written incrementally by each batch step. Count from the
  // DB: a keyword is checked when any device has a snapshot, but the run is
  // partial when any device is missing one, so a lost device still shows.
  const snapshots = await RankTrackingRepository.getSnapshotsForRun(
    input.runId,
  );
  const keywordsChecked = new Set(snapshots.map((s) => s.trackingKeywordId))
    .size;
  const devices: Array<"desktop" | "mobile"> =
    input.devices === "both" ? ["desktop", "mobile"] : [input.devices];
  const checkedByDevice = devices.map((device) => ({
    device,
    count: new Set(
      snapshots
        .filter((s) => s.device === device)
        .map((s) => s.trackingKeywordId),
    ).size,
  }));

  const keywordsTotal = run.keywordsTotal || keywordsChecked;
  const isPartial = checkedByDevice.some((d) => d.count < keywordsTotal);

  // Batch steps record the first per-keyword rejection on the run as it
  // happens, so a failed run shows the vendor's reason rather than a count.
  // A refused task post records nothing there, so its code fills in.
  const keywordError = run.errorMessage ?? input.batchError ?? input.refusal;
  const status =
    keywordsChecked === 0 && keywordsTotal > 0 ? "failed" : "completed";
  const checkedSummary =
    checkedByDevice.length > 1
      ? checkedByDevice
          .map(({ device, count }) => `${count} of ${keywordsTotal} ${device}`)
          .join(" and ")
      : `${keywordsChecked} of ${keywordsTotal}`;
  const errorMessage =
    status === "failed"
      ? (keywordError ?? "No keywords could be checked.")
      : isPartial
        ? `Checked ${checkedSummary} keyword(s)${keywordError ? `: ${keywordError}` : ""}`
        : null;

  // Flipping status away from 'pending'/'running' is what releases the
  // partial-index slot for the next run.
  await RankTrackingRepository.updateRun(input.runId, {
    status,
    keywordsChecked,
    completedAt: nowIso,
    errorMessage,
  });

  // Clear any previous skip reason on success, unless the project's budget
  // stopped this run partway. A failed run must not advance lastCheckedAt —
  // nothing was actually checked.
  // Note: nextCheckAt is NOT set here — the cron handler advances it eagerly
  // before starting the workflow to prevent retry storms.
  const lastSkipReason = input.refusal
    ? PROJECT_REFUSAL_SKIP_REASONS[input.refusal]
    : null;
  if (status === "completed") {
    await RankTrackingRepository.updateConfig(input.configId, input.projectId, {
      lastCheckedAt: nowIso,
      lastSkipReason,
    });
  } else if (lastSkipReason) {
    await RankTrackingRepository.updateConfig(input.configId, input.projectId, {
      lastSkipReason,
    });
  }

  // One-line summary per run, visible in Workers Logs.
  // Error text can echo vendor/user content — keep it one line and bounded.
  const errorSummary = errorMessage
    ? ` error="${errorMessage.replace(/\s+/g, " ").slice(0, 200)}"`
    : "";
  console.log(
    `[rank-check] ${input.runId} ${status} org=${input.billingCustomer.organizationId} project=${input.projectId} trigger=${input.trigger} keywords=${keywordsChecked}/${keywordsTotal}${errorSummary}`,
  );

  await captureServerEvent({
    distinctId: input.billingCustomer.userId,
    event: "rank_tracking:check_complete",
    organizationId: input.billingCustomer.organizationId,
    properties: {
      project_id: input.projectId,
      status,
      trigger: input.trigger,
      keywords_checked: keywordsChecked,
    },
  });
}

async function markRankCheckRunFailed(input: {
  runId: string;
  configId: string;
  projectId: string;
  billingCustomer: ProjectBillingCustomer;
  error: unknown;
}) {
  // run() catches the error the engine rebuilt from the failed step, never
  // the thrown object, with the message prefixed by the error's name. A
  // refusal's bare code under that prefix is what the run keeps, so the
  // credits card shows and the config can say why the check was skipped.
  const message =
    input.error instanceof Error ? input.error.message : "Unknown error";
  const bare = message.replace(/^\w+: /, "");
  const refusal = isErrorCode(bare) ? bare : null;
  await failRunIfActive(input.runId, refusal ?? message);

  // Flag the config so the UI can show why the scheduled check was skipped
  const projectRefusal = stepProjectRefusal(input.error);
  const lastSkipReason: RankTrackingSkipReason | null = projectRefusal
    ? PROJECT_REFUSAL_SKIP_REASONS[projectRefusal]
    : refusal === "INSUFFICIENT_CREDITS"
      ? "insufficient_credits"
      : null;
  if (lastSkipReason) {
    await RankTrackingRepository.updateConfig(input.configId, input.projectId, {
      lastSkipReason,
    });
  }

  await captureServerEvent({
    distinctId: input.billingCustomer.userId,
    event: "rank_tracking:check_complete",
    organizationId: input.billingCustomer.organizationId,
    properties: {
      project_id: input.projectId,
      status: "failed",
      // A code, not the message: provider errors can quote keywords or domains.
      error_code: refusal ?? "INTERNAL_ERROR",
    },
  });
}

export class RankCheckWorkflow extends WorkflowEntrypoint<
  Env,
  RankCheckParams
> {
  async run(event: WorkflowEvent<RankCheckParams>, step: WorkflowStep) {
    // Scope a per-request Postgres client for this workflow invocation (no-op in
    // D1 mode). The socket is reclaimed when the invocation ends, so there is
    // nothing to tear down here.
    return withPgClient(() => this.runScoped(event, step));
  }

  private async runScoped(
    event: WorkflowEvent<RankCheckParams>,
    step: WorkflowStep,
  ) {
    const {
      runId,
      configId,
      billingCustomer,
      projectId,
      domain,
      locationCode,
      languageCode,
      locationName,
      devices,
      serpDepth,
      trigger,
      keywordIds,
      maxCostCredits,
    } = event.payload;

    // Guard: skip if config was archived after the workflow was triggered
    const configCheck = await pgStep(
      step,
      "check-active",
      FREE_STEP_CONFIG,
      async () => {
        const cfg = await RankTrackingRepository.getConfigById({
          configId,
          projectId,
        });
        return { isActive: cfg?.isActive ?? false };
      },
    );
    if (!configCheck.isActive) {
      await failRunIfActive(runId, "Config has been archived");
      return;
    }

    try {
      console.log(
        `[rank-check] ${runId} starting (trigger=${trigger}, devices=${devices})`,
      );

      const prepareResult = await pgStep(
        step,
        "prepare",
        FREE_STEP_CONFIG,
        async () =>
          prepareRankCheckKeywords({
            runId,
            configId,
            billingCustomer,
            devices,
            serpDepth,
            trigger,
            keywordIds,
            maxCostCredits,
          }),
      );

      const keywords = prepareResult.keywords;
      const client = createDataforseoClient({ ...billingCustomer, runId });

      console.log(`[rank-check] ${runId} loaded ${keywords.length} keywords`);

      let batchError: string | null = null;
      let refusal: ProjectRefusalCode | null = null;

      try {
        const checkContext = {
          client,
          keywords,
          devices,
          serpDepth,
          domain,
          locationCode,
          languageCode,
          locationName,
          runId,
        };
        // Scheduled checks use DataForSEO's task queue (~30% of live cost);
        // manual checks stay on the live endpoint for instant results.
        // Retries always go through the queue.
        refusal =
          trigger === "scheduled"
            ? await runQueuedCheck(step, checkContext)
            : await runLiveCheck(step, checkContext);
        refusal = await retryRankChecks(
          step,
          checkContext,
          configId,
          trigger,
          refusal,
        );
      } catch (error) {
        // Batch failure — snapshots for completed batches are already
        // persisted incrementally. Continue to finalization.
        batchError = error instanceof Error ? error.message : String(error);
        console.warn(`[rank-check] ${runId} partial failure: ${batchError}`);
      }

      await pgStep(step, "finalize", FREE_STEP_CONFIG, async () =>
        finalizeRankCheckRun({
          runId,
          configId,
          projectId,
          billingCustomer,
          trigger,
          devices,
          batchError,
          refusal,
        }),
      );
    } catch (error) {
      const refusal = stepProjectRefusal(error);
      if (refusal) console.info(`[rank-check] ${runId} skipped: ${refusal}`);
      else
        console.error(
          `Rank check ${runId} failed: ${describeError(error)}`,
          error,
        );
      // A retry after the body finished (an engine storage failure) sends the
      // failed event again; harmless.
      await pgStep(step, "mark-failed", FREE_STEP_CONFIG, async () =>
        markRankCheckRunFailed({
          runId,
          configId,
          projectId,
          billingCustomer,
          error,
        }),
      );
      throw error;
    }
  }
}

import { revalidateLogic } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { z } from "zod";
import { useAppForm } from "@/client/components/form/useAppForm";
import { SectionHeader } from "@/client/components/PageHeader";
import { useCanManageBilling } from "@/client/features/team/organizationQueries";
import { updateProjectDataforseoBudget } from "@/serverFunctions/projectDataforseoBudgets";
import {
  apiSpendingQueryKey,
  type ProjectApiSpending,
} from "./apiSpendingQueries";

// Limits are typed as text: empty means no limit, "0" is a limit that blocks
// all new paid usage. The two must never collapse into each other.
const limitField = z
  .string()
  .trim()
  .regex(/^(\d+(\.\d{1,2})?)?$/, "Enter dollars and cents, like 25 or 25.50.");

const limitsSchema = z.object({
  monthlyLimitUsd: limitField,
  totalLimitUsd: limitField,
  paused: z.boolean(),
});

type LimitsValues = z.infer<typeof limitsSchema>;

const toLimit = (value: string) =>
  value.trim() === "" ? null : Number(value.trim());

// Limits have at most two decimals, so toFixed(2) is exact.
const fromLimit = (limit: number | null) =>
  limit === null ? "" : limit.toFixed(2);

export function BudgetLimitsForm({
  projectId,
  summary,
}: {
  projectId: string;
  summary: ProjectApiSpending;
}) {
  const queryClient = useQueryClient();
  const canManage = useCanManageBilling();

  const updateMutation = useMutation({
    mutationFn: (values: LimitsValues) =>
      updateProjectDataforseoBudget({
        data: {
          projectId,
          monthlyLimitUsd: toLimit(values.monthlyLimitUsd),
          totalLimitUsd: toLimit(values.totalLimitUsd),
          paused: values.paused,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: apiSpendingQueryKey });
      toast.success("API spending limits saved");
    },
  });

  const form = useAppForm({
    defaultValues: {
      monthlyLimitUsd: fromLimit(summary.monthlyLimitUsd),
      totalLimitUsd: fromLimit(summary.totalLimitUsd),
      paused: summary.paused,
    },
    validationLogic: revalidateLogic(),
    validators: { onDynamic: limitsSchema },
    onSubmit: async ({ value, formApi }) => {
      await updateMutation.mutateAsync(value);
      // The saved values are the new baseline, so Save disables again unless
      // an edit was made while the save ran.
      if (formApi.state.values === value) formApi.reset(value);
    },
  });

  const disabled = !canManage;
  const limitHint =
    "Leave empty for no limit. 0 stops all new paid usage. Lowering a limit never deletes usage.";

  return (
    <section className="space-y-3">
      <SectionHeader
        title="Limits"
        hint="Monthly limits follow UTC calendar months. Limits are ceilings for this project, not a share of your DataForSEO balance."
      />
      <form.AppForm>
        <form.Form className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <form.AppField name="monthlyLimitUsd">
              {(field) => (
                <field.TextField
                  label="Monthly limit (USD)"
                  description={limitHint}
                  placeholder="No limit"
                  inputMode="decimal"
                  autoComplete="off"
                  disabled={disabled}
                />
              )}
            </form.AppField>
            <form.AppField name="totalLimitUsd">
              {(field) => (
                <field.TextField
                  label="Total limit (USD)"
                  description="Covers all usage since tracking started, including any opening balance."
                  placeholder="No limit"
                  inputMode="decimal"
                  autoComplete="off"
                  disabled={disabled}
                />
              )}
            </form.AppField>
          </div>

          <form.AppField name="paused">
            {(field) => (
              <field.SwitchField
                label="Pause paid DataForSEO usage"
                description="New paid calls are refused. Calls already sent still finish, and saved results stay available."
                disabled={disabled}
              />
            )}
          </form.AppField>

          {canManage ? (
            <div className="flex justify-end">
              <form.Subscribe selector={(state) => state.isDefaultValue}>
                {(isDefaultValue) => (
                  // A never-configured project can save its defaults, which
                  // records an explicit "unlimited" choice.
                  <form.SubmitButton
                    disabled={isDefaultValue && summary.configured}
                  >
                    Save limits
                  </form.SubmitButton>
                )}
              </form.Subscribe>
            </div>
          ) : (
            // Not PermissionHint: admins cannot change limits either.
            <p className="text-sm text-muted-foreground">
              Only an organization owner can change these limits.
            </p>
          )}
        </form.Form>
      </form.AppForm>
    </section>
  );
}

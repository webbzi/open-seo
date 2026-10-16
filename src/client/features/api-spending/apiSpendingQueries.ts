import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import {
  getOrganizationDataforseoSpending,
  getProjectDataforseoBudget,
  listProjectDataforseoUsage,
} from "@/serverFunctions/projectDataforseoBudgets";

/** Every API spending query. A limit change invalidates them all. */
export const apiSpendingQueryKey = ["apiSpending"] as const;

export const projectApiSpendingQueryOptions = (projectId: string) =>
  queryOptions({
    queryKey: [...apiSpendingQueryKey, "project", projectId],
    queryFn: () => getProjectDataforseoBudget({ data: { projectId } }),
  });

export const projectApiUsageQueryOptions = (projectId: string, page: number) =>
  queryOptions({
    queryKey: [...apiSpendingQueryKey, "project", projectId, "usage", page],
    queryFn: () => listProjectDataforseoUsage({ data: { projectId, page } }),
    // Keep the current page on screen while the next one loads.
    placeholderData: keepPreviousData,
  });

export const organizationApiSpendingQueryOptions = () =>
  queryOptions({
    queryKey: [...apiSpendingQueryKey, "organization"],
    queryFn: () => getOrganizationDataforseoSpending(),
  });

export type ProjectApiSpending = Awaited<
  ReturnType<typeof getProjectDataforseoBudget>
>;
export type ApiUsageRow = Awaited<
  ReturnType<typeof listProjectDataforseoUsage>
>["rows"][number];
export type OrganizationApiSpendingRow = Awaited<
  ReturnType<typeof getOrganizationDataforseoSpending>
>[number];

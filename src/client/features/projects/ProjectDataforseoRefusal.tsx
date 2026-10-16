import { Link } from "@tanstack/react-router";
import { getStandardErrorMessage } from "@/client/lib/error-messages";

type ProjectDataforseoRefusalCode =
  | "PROJECT_BUDGET_EXCEEDED"
  | "PROJECT_DATAFORSEO_PAUSED";

/**
 * The self-hosted project DataForSEO refusal behind an error code, an AI
 * tracker notice, or a rank tracker skip reason, or null for anything else.
 */
export function projectDataforseoRefusalCode(
  value: string | null | undefined,
): ProjectDataforseoRefusalCode | null {
  switch (value) {
    case "PROJECT_BUDGET_EXCEEDED":
    case "project_budget_exceeded":
      return "PROJECT_BUDGET_EXCEEDED";
    case "PROJECT_DATAFORSEO_PAUSED":
    case "project_dataforseo_paused":
      return "PROJECT_DATAFORSEO_PAUSED";
    default:
      return null;
  }
}

/**
 * Why the project's paid DataForSEO work stopped, with a link to the settings
 * tab that changes it. The owner set this limit, so it never offers credits.
 */
export function ProjectDataforseoRefusal({
  projectId,
  code,
}: {
  projectId: string;
  code: ProjectDataforseoRefusalCode;
}) {
  return (
    <>
      {getStandardErrorMessage(new Error(code))}{" "}
      <Link
        to="/p/$projectId/settings/api-spending"
        params={{ projectId }}
        className="text-primary underline"
      >
        Open API spending
      </Link>
    </>
  );
}

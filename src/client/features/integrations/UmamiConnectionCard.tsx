import * as React from "react";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";
import { toast } from "sonner";
import { CardShell } from "@/client/components/CardShell";
import { ConfirmDialog } from "@/client/components/ConfirmDialog";
import { PermissionHint } from "@/client/components/PermissionHint";
import { QueryError } from "@/client/components/QueryState";
import { SafeExternalLink } from "@/client/components/SafeExternalLink";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/client/components/ui/select";
import { Skeleton } from "@/client/components/ui/skeleton";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  disconnectUmami,
  getUmamiConnection,
  listUmamiWebsites,
  setUmamiWebsite,
} from "@/serverFunctions/umami";

const UMAMI_SETUP_DOCS_URL =
  "https://github.com/every-app/open-seo/blob/main/docs/SELF_HOSTING_UMAMI.md";

const docsLinkClassName =
  "inline-flex items-center gap-1 font-medium underline underline-offset-2";

type UmamiConnection = Awaited<ReturnType<typeof getUmamiConnection>>;
type UmamiWebsite = Awaited<
  ReturnType<typeof listUmamiWebsites>
>["websites"][number];

export const umamiConnectionOptions = (projectId: string) =>
  queryOptions({
    queryKey: ["umamiConnection", projectId],
    queryFn: () => getUmamiConnection({ data: { projectId } }),
  });

function websiteLabel(website: { name: string; domain: string | null }) {
  return website.domain ? `${website.name} · ${website.domain}` : website.name;
}

/** Maps one project to a website on the deployment's Umami instance. */
export function UmamiConnectionCard({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const connectionOptions = umamiConnectionOptions(projectId);
  const connectionQuery = useQuery(connectionOptions);
  const connection = connectionQuery.data;
  const [picking, setPicking] = React.useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = React.useState(false);

  const configured = connection?.configured === true;
  const connected = configured && connection.connected;
  const canManage = connection?.canManage === true;
  const showPicker = configured && canManage && (picking || !connected);

  const websitesKey = ["umamiWebsites", projectId];
  const websitesQuery = useQuery({
    queryKey: websitesKey,
    queryFn: () => listUmamiWebsites({ data: { projectId } }),
    enabled: showPicker,
    // The card has its own Retry; the default 3 retries leave the picker
    // loading for up to a minute.
    retry: false,
  });

  // Seeds the connection before the refetch lands, so the card doesn't flash
  // back to the picker (and rerun discovery) in between.
  const afterChange = (update: Partial<UmamiConnection>) => {
    queryClient.setQueryData(connectionOptions.queryKey, (current) =>
      current ? { ...current, ...update } : current,
    );
    // The next picker opens on a fresh discovery.
    queryClient.removeQueries({ queryKey: websitesKey });
    void queryClient.invalidateQueries({
      queryKey: connectionOptions.queryKey,
    });
    // The dashboard card would otherwise keep the previous website's numbers.
    void queryClient.invalidateQueries({
      queryKey: ["dashboardActivation", projectId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["dashboardUmamiReport", projectId],
    });
    setPicking(false);
  };
  const connectMutation = useMutation({
    meta: { errorToast: false },
    mutationFn: (websiteId: string) =>
      setUmamiWebsite({
        data: {
          projectId,
          websiteId,
          // Umami websites have no time zone; reports use the browser's.
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      }),
    onSuccess: (saved) => {
      toast.success("Umami connected");
      afterChange({ connected: true, ...saved });
    },
  });
  const disconnectMutation = useMutation({
    meta: { errorToast: false },
    mutationFn: () => disconnectUmami({ data: { projectId } }),
    onSuccess: () => {
      toast.success("Umami disconnected from this project");
      afterChange({ connected: false, websiteId: null });
    },
    onSettled: () => setConfirmingDisconnect(false),
  });
  const mutationError = connectMutation.error ?? disconnectMutation.error;

  return (
    <CardShell
      title="Umami"
      icon={<BarChart3 className="size-5" />}
      action={
        connection ? (
          <Badge variant={connected ? "success" : "outline"}>
            <span className="size-1.5 rounded-full bg-current" />
            {connected
              ? "Connected"
              : configured
                ? "Not connected"
                : "Not configured"}
          </Badge>
        ) : undefined
      }
    >
      {connectionQuery.isPending ? (
        <div
          role="status"
          aria-label="Loading connection"
          className="space-y-3"
        >
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-9 w-24" />
        </div>
      ) : !connection ? (
        <QueryError
          error={connectionQuery.error}
          fallback="Couldn't check this project's connection."
          onRetry={() => void connectionQuery.refetch()}
          isRetrying={connectionQuery.isFetching}
        />
      ) : !configured ? (
        <p className="text-sm text-muted-foreground">
          Umami isn&apos;t set up on this OpenSEO deployment.{" "}
          <SafeExternalLink
            url={UMAMI_SETUP_DOCS_URL}
            label="Open setup guide"
            className={docsLinkClassName}
          />
        </p>
      ) : showPicker ? (
        <UmamiWebsitePicker
          key={connection.websiteId ?? "new"}
          initialWebsiteId={connection.websiteId}
          loading={websitesQuery.isPending}
          error={websitesQuery.isError ? websitesQuery.error : null}
          websites={websitesQuery.data?.websites ?? []}
          onRetry={() => void websitesQuery.refetch()}
          retrying={websitesQuery.isFetching}
          saving={connectMutation.isPending}
          saveLabel={connected ? "Save website" : "Connect"}
          onSave={(websiteId) => connectMutation.mutate(websiteId)}
          onCancel={
            connected
              ? () => {
                  setPicking(false);
                  connectMutation.reset();
                }
              : undefined
          }
        />
      ) : connected ? (
        <div className="space-y-4">
          <div className="min-w-0">
            <p className="break-words text-sm font-semibold">
              {connection.websiteName}
            </p>
            {connection.websiteDomain ? (
              <p className="mt-1 break-all text-sm text-muted-foreground">
                {connection.websiteDomain}
              </p>
            ) : null}
            <p className="mt-1 text-xs text-muted-foreground">
              Time zone {connection.timeZone}
            </p>
          </div>
          {canManage ? (
            <div className="flex flex-wrap items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                disabled={disconnectMutation.isPending}
                onClick={() => {
                  connectMutation.reset();
                  disconnectMutation.reset();
                  setPicking(true);
                }}
              >
                Change website
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={disconnectMutation.isPending}
                onClick={() => {
                  disconnectMutation.reset();
                  setConfirmingDisconnect(true);
                }}
              >
                Disconnect project
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No Umami website is connected to this project.
        </p>
      )}
      {mutationError ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {getStandardErrorMessage(mutationError)}
        </p>
      ) : null}
      {configured && !canManage ? (
        <PermissionHint
          action="change this project's connection"
          className="mt-3"
        />
      ) : null}
      {confirmingDisconnect ? (
        <ConfirmDialog
          title="Disconnect Umami?"
          confirmLabel="Disconnect"
          destructive
          pending={disconnectMutation.isPending}
          onConfirm={() => disconnectMutation.mutate()}
          onClose={() => setConfirmingDisconnect(false)}
        >
          This project stops reading analytics from{" "}
          {connection?.websiteName ?? "its Umami website"}. Nothing changes in
          Umami, and you can connect it again later.
        </ConfirmDialog>
      ) : null}
    </CardShell>
  );
}

function UmamiWebsitePicker({
  initialWebsiteId,
  loading,
  error,
  websites,
  onRetry,
  retrying,
  saving,
  saveLabel,
  onSave,
  onCancel,
}: {
  initialWebsiteId: string | null;
  loading: boolean;
  error: unknown;
  websites: UmamiWebsite[];
  onRetry: () => void;
  retrying: boolean;
  saving: boolean;
  saveLabel: string;
  onSave: (websiteId: string) => void;
  onCancel?: () => void;
}) {
  const [choice, setChoice] = React.useState(initialWebsiteId);
  const items = websites.map((website) => ({
    value: website.id,
    label: websiteLabel(website),
  }));
  // A saved website the key can no longer see is not preselected.
  const websiteId = items.some((item) => item.value === choice) ? choice : null;

  if (loading) {
    return (
      <div role="status" aria-label="Loading websites" className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-9 w-24" />
      </div>
    );
  }
  if (error) {
    return (
      <QueryError
        error={error}
        fallback="Couldn't load websites from Umami."
        onRetry={onRetry}
        isRetrying={retrying}
      />
    );
  }

  const cancelButton = onCancel ? (
    <Button variant="ghost" size="sm" disabled={saving} onClick={onCancel}>
      Cancel
    </Button>
  ) : null;

  if (items.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          The Umami API key on this deployment can&apos;t see any websites.{" "}
          <SafeExternalLink
            url={UMAMI_SETUP_DOCS_URL}
            label="Open setup guide"
            className={docsLinkClassName}
          />
        </p>
        {cancelButton}
      </div>
    );
  }

  return (
    <fieldset disabled={saving} className="space-y-3">
      <Select items={items} value={websiteId} onValueChange={setChoice}>
        <SelectTrigger className="w-full" aria-label="Umami website">
          <SelectValue placeholder="Choose a website" />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="flex flex-wrap items-center gap-1">
        <Button
          size="sm"
          pending={saving}
          disabled={!websiteId}
          onClick={() => websiteId && onSave(websiteId)}
        >
          {saveLabel}
        </Button>
        {cancelButton}
      </div>
    </fieldset>
  );
}

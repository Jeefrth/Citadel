import { useEffect, useRef, useState, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { api, getAuthToken, wsBaseUrl } from "@/services/api";
import { reauthenticate } from "@/services/reauth";
import { hasAction, type ConnectionChoice, type ServerData } from "@/services/types";
import Terminal from "@/components/Terminal";
import RdpViewer from "@/components/RdpViewer";
import ConnectDialog from "@/components/ConnectDialog";
import { EmptyState } from "@/components/kit";
import { Button } from "@/components/ui/button";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { motion } from "motion/react";
import { Terminal as TerminalIcon, Plus, X, Monitor } from "lucide-react";

interface Tab {
  id: string;
  serverId: string;
  serverName: string;
  /** Display parts of the tab (serverName keeps the historical "name (account)" form). */
  serverLabel: string;
  accountLabel: string;
  protocol: "ssh" | "rdp" | "k8s";
  /** Kubernetes shell: WebSocket path and auth fields (stable object, kept with the tab). */
  k8s?: { path: string; auth: { namespace: string; pod: string; container: string } };
  certDuration?: number;
  connection: ConnectionChoice;
  osType: string;
  connected: boolean;
}

let tabCounter = 0;

export default function TerminalPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [servers, setServers] = useState<ServerData[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [showServerPicker, setShowServerPicker] = useState(false);

  // Account choice + MFA confirmation before opening a session
  const [pendingServer, setPendingServer] = useState<ServerData | null>(null);

  useEffect(() => {
    api
      .get<ServerData[]>("/api/servers/")
      .then((list) => {
        setServers(list);
        // Deep link from the Servers / ServerDetail pages: /terminal?server=<id>
        const wanted = searchParams.get("server");
        if (wanted) {
          const srv = list.find((s) => s.id === wanted);
          if (srv && hasAction(srv, "connect")) setPendingServer(srv);
          setSearchParams({}, { replace: true });
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Deep link from the Kubernetes pages: /terminal?k8s=<cluster>&name=&ns=&pod=&container=
  const k8sLinkHandled = useRef<string | null>(null);
  useEffect(() => {
    const clusterId = searchParams.get("k8s");
    if (!clusterId) return;
    const key = searchParams.toString();
    if (k8sLinkHandled.current === key) return; // StrictMode double run
    k8sLinkHandled.current = key;
    const ns = searchParams.get("ns") || "";
    const pod = searchParams.get("pod") || "";
    const container = searchParams.get("container") || "";
    const clusterName = searchParams.get("name") || clusterId.slice(0, 8);
    if (ns && pod) {
      const label = `${clusterName}/${ns}/${pod}${container ? `/${container}` : ""}`;
      const id = `tab-${++tabCounter}`;
      const tab: Tab = {
        id,
        serverId: clusterId,
        serverName: label,
        serverLabel: label,
        accountLabel: `k8s:${ns}`,
        protocol: "k8s",
        k8s: { path: `/ws/k8s-exec/${encodeURIComponent(clusterId)}`, auth: { namespace: ns, pod, container } },
        osType: "linux",
        connection: { label: `k8s:${ns}` } as ConnectionChoice,
        connected: true,
      };
      setTabs((prev) => [...prev, tab]);
      setActiveTab(id);
    }
    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);

  // Citadel access token (refreshed in the background)
  const getToken = useCallback(async (): Promise<string> => getAuthToken(), []);

  const requestTerminal = (srv: ServerData) => {
    setPendingServer(srv);
    setShowServerPicker(false);
  };

  // Called by ConnectDialog; throwing keeps the dialog open with the error shown
  const confirmMfaAndOpen = async (connection: ConnectionChoice, certDuration?: number) => {
    if (!pendingServer) return;

    // Sign in again at the provider (popup, MFA by the provider's policy): new auth_time
    await reauthenticate();

    // Re-authenticated: open the session
    const id = `tab-${++tabCounter}`;
    const tab: Tab = {
      id,
      serverId: pendingServer.id,
      serverName: `${pendingServer.name} (${connection.label})`,
      serverLabel: pendingServer.name,
      accountLabel: connection.label,
      protocol: pendingServer.os_type === "windows" ? "rdp" : "ssh",
      osType: pendingServer.os_type,
      certDuration,
      connection,
      connected: true,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTab(id);
    setPendingServer(null);
  };

  const closeTab = (tabId: string) => {
    setTabs((prev) => {
      const newTabs = prev.filter((t) => t.id !== tabId);
      if (activeTab === tabId) {
        setActiveTab(newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null);
      }
      return newTabs;
    });
  };

  const handleDisconnected = (tabId: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, connected: false } : t))
    );
  };

  // Only servers on which the user holds the "connect" action
  const linuxServers = servers.filter((s) => s.os_type === "linux" && hasAction(s, "connect"));
  const windowsServers = servers.filter((s) => s.os_type === "windows" && hasAction(s, "connect"));

  const connectable = [...linuxServers, ...windowsServers];

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      {/* Session tabs */}
      <div className="flex items-end gap-1 overflow-x-auto border-b px-1">
        {tabs.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setActiveTab(tab.id)}
              title={
                tab.protocol === "k8s"
                  ? `Shell Kubernetes ${tab.serverLabel}${tab.connected ? "" : " (déconnecté)"}`
                  : `${tab.protocol.toUpperCase()} ${tab.serverLabel}, compte ${tab.accountLabel}${tab.connected ? "" : " (déconnecté)"}`
              }
              className={cn(
                "group relative flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-t-md px-3 text-sm transition-colors",
                active ? "bg-card text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
            >
              <LiveDot live={tab.connected} />
              <span className="rounded border px-1 font-mono text-2xs text-muted-foreground">
                {tab.protocol === "rdp" ? "RDP" : tab.protocol === "k8s" ? "k8s" : "SSH"}
              </span>
              {tab.protocol === "k8s" ? (
                <span className="max-w-[280px] truncate font-mono text-xs">{tab.serverLabel}</span>
              ) : (
                <>
                  <span className="max-w-[160px] truncate font-medium">{tab.serverLabel}</span>
                  <span className="max-w-[120px] truncate font-mono text-xs text-muted-foreground">{tab.accountLabel}</span>
                </>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                className="ml-0.5 rounded p-0.5 text-muted-foreground opacity-60 hover:bg-accent hover:text-foreground group-hover:opacity-100"
                aria-label={`Fermer la session ${tab.serverLabel}`}
              >
                <X className="size-3.5" />
              </button>
              {active && (
                <motion.span
                  layoutId="terminal-tab-indicator"
                  className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-live"
                  transition={{ type: "spring", stiffness: 500, damping: 40 }}
                />
              )}
            </div>
          );
        })}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setShowServerPicker(true)}
              className="mb-0.5 size-8 shrink-0 text-muted-foreground"
              aria-label="Ouvrir une session"
            >
              <Plus />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Ouvrir une session</TooltipContent>
        </Tooltip>
      </div>

      {/* Session area */}
      <div className="relative flex-1">
        {tabs.length === 0 && (
          <div className="flex h-full items-center justify-center p-6">
            <EmptyState
              icon={TerminalIcon}
              title="Aucune session ouverte"
              action={
                <Button onClick={() => setShowServerPicker(true)}>
                  <Plus />
                  Ouvrir une session
                </Button>
              }
            >
              {servers.length === 0
                ? "Aucun serveur accessible. Demandez un accès à un administrateur."
                : "Ouvrez un terminal SSH vers un serveur Linux ou une session RDP vers un serveur Windows."}
            </EmptyState>
          </div>
        )}

        {tabs.map((tab) => (
          <div key={tab.id} className={cn("absolute inset-0 p-2", activeTab === tab.id ? "block" : "hidden")}>
            {tab.protocol === "rdp" ? (
              <RdpViewer
                serverId={tab.serverId}
                serverName={tab.serverName}
                connection={tab.connection}
                onDisconnected={() => handleDisconnected(tab.id)}
              />
            ) : tab.protocol === "k8s" && tab.k8s ? (
              <Terminal
                serverId={tab.serverId}
                serverName={tab.serverName}
                getToken={getToken}
                wsBaseUrl={wsBaseUrl()}
                wsPath={tab.k8s.path}
                authExtra={tab.k8s.auth}
                onDisconnected={() => handleDisconnected(tab.id)}
              />
            ) : (
              <Terminal
                serverId={tab.serverId}
                serverName={tab.serverName}
                getToken={getToken}
                certDuration={tab.certDuration}
                connection={tab.connection}
                onDisconnected={() => handleDisconnected(tab.id)}
              />
            )}
          </div>
        ))}
      </div>

      {/* Server picker */}
      <CommandDialog open={showServerPicker} onOpenChange={setShowServerPicker}>
        <CommandInput placeholder="Rechercher un serveur (nom, IP, nœud)" />
        <CommandList className="max-h-96">
          <CommandEmpty>
            {connectable.length === 0
              ? "Aucun serveur sur lequel vous pouvez vous connecter."
              : "Aucun serveur ne correspond."}
          </CommandEmpty>
          {linuxServers.length > 0 && (
            <CommandGroup heading="Linux, SSH">
              {linuxServers.map((srv) => (
                <PickerItem key={srv.id} srv={srv} onSelect={() => requestTerminal(srv)} />
              ))}
            </CommandGroup>
          )}
          {windowsServers.length > 0 && (
            <CommandGroup heading="Windows, RDP">
              {windowsServers.map((srv) => (
                <PickerItem key={srv.id} srv={srv} onSelect={() => requestTerminal(srv)} />
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </CommandDialog>

      {/* Account choice + MFA confirmation */}
      {pendingServer && (
        <ConnectDialog
          server={pendingServer}
          onCancel={() => setPendingServer(null)}
          onConfirm={confirmMfaAndOpen}
        />
      )}
    </div>
  );
}

/** Session state: amber pulse while the session is live, muted once it ended. */
function LiveDot({ live }: { live: boolean }) {
  return (
    <span className="relative flex size-2 shrink-0 items-center justify-center" aria-label={live ? "Connectée" : "Déconnectée"}>
      {live && (
        <motion.span
          className="absolute inset-0 rounded-full bg-live"
          initial={{ scale: 1, opacity: 0.6 }}
          animate={{ scale: 2.4, opacity: 0 }}
          transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
        />
      )}
      <span className={cn("relative size-2 rounded-full", live ? "bg-live" : "bg-muted-foreground/40")} />
    </span>
  );
}

function PickerItem({ srv, onSelect }: { srv: ServerData; onSelect: () => void }) {
  return (
    <CommandItem
      value={`${srv.name} ${srv.ip_address} ${srv.hostname} ${srv.node_path || ""} ${srv.id}`}
      onSelect={onSelect}
      className="gap-3"
    >
      {srv.os_type === "windows" ? (
        <Monitor className="text-muted-foreground" />
      ) : (
        <TerminalIcon className="text-muted-foreground" />
      )}
      <div className="min-w-0">
        <p className="truncate font-medium">{srv.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          <span className="font-mono">{srv.ip_address}</span> · {srv.node_path || <span className="font-mono">{srv.hostname}</span>}
        </p>
      </div>
      {srv.default_account && (
        <span className="ml-auto font-mono text-xs text-muted-foreground">{srv.default_account.username}</span>
      )}
    </CommandItem>
  );
}

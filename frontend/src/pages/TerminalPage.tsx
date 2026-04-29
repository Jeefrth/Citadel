import { useEffect, useState, useCallback } from "react";
import { useMsal } from "@azure/msal-react";
import { loginRequest } from "@/services/authConfig";
import { api } from "@/services/api";
import Terminal from "@/components/Terminal";
import {
  Terminal as TerminalIcon,
  Plus,
  X,
  Server,
  Monitor,
} from "lucide-react";

interface ServerData {
  id: string;
  name: string;
  hostname: string;
  ip_address: string;
  os_type: "linux" | "windows";
  status: string;
  credential_id: string | null;
}

interface Tab {
  id: string;
  serverId: string;
  serverName: string;
  osType: string;
  connected: boolean;
}

let tabCounter = 0;

export default function TerminalPage() {
  const { instance, accounts } = useMsal();
  const [servers, setServers] = useState<ServerData[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [showServerPicker, setShowServerPicker] = useState(false);

  useEffect(() => {
    api
      .get<ServerData[]>("/api/servers/")
      .then(setServers)
      .catch(() => {});
  }, []);

  const getToken = useCallback(async (): Promise<string> => {
    const account = accounts[0];
    if (!account) throw new Error("Not authenticated");
    const response = await instance.acquireTokenSilent({
      ...loginRequest,
      account,
    });
    return response.accessToken;
  }, [instance, accounts]);

  const openTab = (srv: ServerData) => {
    const id = `tab-${++tabCounter}`;
    const tab: Tab = {
      id,
      serverId: srv.id,
      serverName: srv.name,
      osType: srv.os_type,
      connected: true,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTab(id);
    setShowServerPicker(false);
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

  const linuxServers = servers.filter(
    (s) => s.os_type === "linux" && s.credential_id
  );
  const windowsServers = servers.filter(
    (s) => s.os_type === "windows" && s.credential_id
  );

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b bg-muted/30 px-2 pt-2">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-t-md text-sm cursor-pointer border border-b-0 transition-colors ${
              activeTab === tab.id
                ? "bg-card border-border text-foreground"
                : "bg-transparent border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                tab.connected ? "bg-green-500" : "bg-gray-400"
              }`}
            />
            <Monitor size={14} />
            <span className="max-w-[120px] truncate">{tab.serverName}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
              className="ml-1 hover:bg-accent rounded p-0.5"
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button
          onClick={() => setShowServerPicker(true)}
          className="p-1.5 rounded-md hover:bg-accent text-muted-foreground"
          title="Nouveau terminal"
        >
          <Plus size={16} />
        </button>
      </div>

      {/* Terminal area */}
      <div className="flex-1 relative">
        {tabs.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <TerminalIcon
              size={48}
              className="text-muted-foreground mb-4"
            />
            <h3 className="text-lg font-semibold mb-2">Terminal Distant</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Ouvrez un terminal interactif SSH vers vos serveurs Linux.
            </p>
            <button
              onClick={() => setShowServerPicker(true)}
              className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90"
            >
              <Plus size={16} />
              Nouveau terminal
            </button>
            {servers.length === 0 && (
              <p className="text-xs text-muted-foreground mt-4">
                Ajoutez d'abord des serveurs avec des credentials dans la
                section Serveurs.
              </p>
            )}
          </div>
        )}

        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`absolute inset-0 p-2 ${
              activeTab === tab.id ? "block" : "hidden"
            }`}
          >
            <Terminal
              serverId={tab.serverId}
              serverName={tab.serverName}
              getToken={getToken}
              onDisconnected={() => handleDisconnected(tab.id)}
            />
          </div>
        ))}
      </div>

      {/* Server picker modal */}
      {showServerPicker && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card border rounded-lg shadow-lg w-full max-w-md mx-4">
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="font-semibold">Choisir un serveur</h3>
              <button onClick={() => setShowServerPicker(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="p-4 space-y-4 max-h-96 overflow-auto">
              {linuxServers.length === 0 && windowsServers.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  Aucun serveur avec credential configuré.
                </p>
              )}

              {linuxServers.length > 0 && (
                <div>
                  <h4 className="text-xs font-medium text-muted-foreground uppercase mb-2">
                    Linux (SSH)
                  </h4>
                  <div className="space-y-1">
                    {linuxServers.map((srv) => (
                      <button
                        key={srv.id}
                        onClick={() => openTab(srv)}
                        className="w-full flex items-center gap-3 px-3 py-2 rounded-md hover:bg-accent text-left text-sm"
                      >
                        <Server size={16} className="text-green-500" />
                        <div>
                          <p className="font-medium">{srv.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {srv.ip_address} — {srv.hostname}
                          </p>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {windowsServers.length > 0 && (
                <div>
                  <h4 className="text-xs font-medium text-muted-foreground uppercase mb-2">
                    Windows (WinRM)
                  </h4>
                  <div className="space-y-1">
                    {windowsServers.map((srv) => (
                      <button
                        key={srv.id}
                        onClick={() => openTab(srv)}
                        className="w-full flex items-center gap-3 px-3 py-2 rounded-md hover:bg-accent text-left text-sm"
                        title="Terminal interactif non disponible pour Windows — utiliser l'exécution de commande"
                      >
                        <Server size={16} className="text-blue-500" />
                        <div>
                          <p className="font-medium">{srv.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {srv.ip_address} — {srv.hostname}
                          </p>
                        </div>
                        <span className="ml-auto text-xs text-amber-500">
                          Cmd only
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

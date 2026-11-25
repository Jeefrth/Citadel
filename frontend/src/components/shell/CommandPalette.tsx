import { useEffect, useState } from "react";
import { matches, useShortcut } from "@/services/shortcut";
import { useNavigate } from "react-router-dom";
import { useTheme } from "next-themes";
import { AppWindow, Archive, CloudCog, Container, ShieldCheck, EyeOff, KeyRound, Laptop, Moon, Server, ShieldAlert, Sun, Terminal, UserCog, UserPlus } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { api } from "@/services/api";
import type { K8sCluster } from "@/services/k8s";
import { NAV, type NavRequirement } from "./nav";

interface ServerLite {
  id: string;
  name: string;
  ip_address: string;
  node_path: string | null;
  os_type: string;
  actions: string[];
}

export function useCommandPalette() {
  const [open, setOpen] = useState(false);
  const [shortcut] = useShortcut();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matches(e, shortcut)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcut]);
  return { open, setOpen };
}

export default function CommandPalette({
  open,
  onOpenChange,
  allows,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  allows: (req: NavRequirement | undefined) => boolean;
}) {
  const navigate = useNavigate();
  const { resolvedTheme, setTheme } = useTheme();
  const [servers, setServers] = useState<ServerLite[]>([]);
  const [clusters, setClusters] = useState<K8sCluster[]>([]);
  const k8sVisible = allows("k8s");

  useEffect(() => {
    if (!open) return;
    api.get<ServerLite[]>("/api/servers/").then(setServers).catch(() => setServers([]));
  }, [open]);

  useEffect(() => {
    if (!open || !k8sVisible) return;
    api.get<K8sCluster[]>("/api/k8s/clusters").then(setClusters).catch(() => setClusters([]));
  }, [open, k8sVisible]);

  const go = (to: string) => {
    onOpenChange(false);
    navigate(to);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Aller à une page, un serveur, une action..." />
      <CommandList>
        <CommandEmpty>Rien ne correspond.</CommandEmpty>

        {servers.length > 0 && (
          <CommandGroup heading="Serveurs">
            {servers.map((s) => (
              <CommandItem
                key={s.id}
                value={`${s.name} ${s.ip_address} ${s.node_path ?? ""}`}
                onSelect={() => go(`/servers/${s.id}`)}
              >
                <Server />
                <span className="font-medium">{s.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{s.ip_address}</span>
                {s.node_path && <span className="truncate text-xs text-muted-foreground">{s.node_path}</span>}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {servers.some((s) => s.actions.includes("connect")) && (
          <CommandGroup heading="Se connecter">
            {servers
              .filter((s) => s.actions.includes("connect"))
              .map((s) => (
                <CommandItem
                  key={`c-${s.id}`}
                  value={`connexion terminal rdp ${s.name} ${s.ip_address}`}
                  onSelect={() => go(`/terminal?server=${s.id}`)}
                >
                  <Terminal />
                  <span>
                    Ouvrir une session sur <span className="font-medium">{s.name}</span>
                  </span>
                  <CommandShortcut>{s.os_type === "windows" ? "RDP" : "SSH"}</CommandShortcut>
                </CommandItem>
              ))}
          </CommandGroup>
        )}

        {clusters.length > 0 && (
          <CommandGroup heading="Clusters Kubernetes">
            {clusters.map((c) => (
              <CommandItem
                key={`k-${c.id}`}
                value={`kubernetes k8s cluster ${c.name} ${c.api_url}`}
                onSelect={() => go(`/kubernetes/${c.id}`)}
              >
                <Container />
                <span className="font-medium">{c.name}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">{c.api_url}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandSeparator />
        {NAV.map((group) => {
          const items = group.items.filter((i) => allows(i.perm));
          if (!items.length) return null;
          return (
            <CommandGroup key={group.label} heading={group.label}>
              {items.map((i) => (
                <CommandItem key={i.to} value={`${group.label} ${i.label}`} onSelect={() => go(i.to)}>
                  <i.icon />
                  {i.label}
                </CommandItem>
              ))}
            </CommandGroup>
          );
        })}

        <CommandSeparator />
        <CommandGroup heading="Actions">
          <CommandItem value="demander un accès temporaire" onSelect={() => go("/approvals?request=1")}>
            <KeyRound />
            Demander un accès temporaire
          </CommandItem>
          <CommandItem value="mes appareils déconnecter navigateur mon compte" onSelect={() => go("/account")}>
            <Laptop />
            Gérer mes appareils
          </CommandItem>
          <CommandItem value="accès ssh proxy clé publique jeton de connexion mon compte" onSelect={() => go("/account#ssh")}>
            <Terminal />
            Préparer mon accès SSH
          </CommandItem>
          {allows("servers") && (
            <CommandItem value="valider nouvelles vm cloud azure à valider" onSelect={() => go("/infrastructure?tab=pending")}>
              <CloudCog />
              Valider les nouvelles VM cloud
            </CommandItem>
          )}
          {allows("secrets") && (
            <CommandItem value="modèles de comptes pousser push compte" onSelect={() => go("/infrastructure?tab=templates")}>
              <UserPlus />
              Pousser un compte sur des serveurs
            </CommandItem>
          )}
          {allows("kubernetes") && (
            <>
              <CommandItem value="ajouter un cluster kubernetes k8s" onSelect={() => go("/kubernetes?new=1")}>
                <Container />
                Ajouter un cluster Kubernetes
              </CommandItem>
              <CommandItem value="règles d'accès kubernetes k8s espaces de noms" onSelect={() => go("/kubernetes?tab=policies")}>
                <ShieldCheck />
                Gérer les règles d'accès Kubernetes
              </CommandItem>
            </>
          )}
          {allows("audit") && (
            <CommandItem value="risques analyser" onSelect={() => go("/risks")}>
              <ShieldAlert />
              Voir les risques
            </CommandItem>
          )}
          {allows("admin") && (
            <>
              <CommandItem value="sauvegarde chiffrée des comptes sauvegarder" onSelect={() => go("/settings?tab=backups")}>
                <Archive />
                Sauvegarder les comptes
              </CommandItem>
              <CommandItem value="masquage des données terminal" onSelect={() => go("/settings?tab=masking")}>
                <EyeOff />
                Régler le masquage des données
              </CommandItem>
              <CommandItem value="applications api secrets clé" onSelect={() => go("/settings?tab=applications")}>
                <AppWindow />
                Gérer les applications
              </CommandItem>
              <CommandItem value="rôles personnalisés permissions" onSelect={() => go("/settings?tab=roles")}>
                <UserCog />
                Gérer les rôles
              </CommandItem>
            </>
          )}
          <CommandItem
            value="thème clair sombre"
            onSelect={() => {
              setTheme(resolvedTheme === "dark" ? "light" : "dark");
              onOpenChange(false);
            }}
          >
            {resolvedTheme === "dark" ? <Sun /> : <Moon />}
            {resolvedTheme === "dark" ? "Passer en thème clair" : "Passer en thème sombre"}
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

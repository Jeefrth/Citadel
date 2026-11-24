import { useMemo, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  Layers,
  Pencil,
  Trash2,
} from "lucide-react";
import type { NodeData } from "@/services/types";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface TreeItem {
  node: NodeData;
  children: TreeItem[];
  total: number; // servers in this node and its sub-nodes
}

function buildTree(nodes: NodeData[]): TreeItem[] {
  const items = new Map<string, TreeItem>();
  nodes.forEach((n) => items.set(n.id, { node: n, children: [], total: n.server_count }));
  const roots: TreeItem[] = [];
  nodes.forEach((n) => {
    const item = items.get(n.id)!;
    const parent = n.parent_id ? items.get(n.parent_id) : undefined;
    if (parent) parent.children.push(item);
    else roots.push(item);
  });
  const sum = (it: TreeItem): number => {
    it.children.sort((a, b) => a.node.name.localeCompare(b.node.name));
    it.total = it.node.server_count + it.children.reduce((acc, c) => acc + sum(c), 0);
    return it.total;
  };
  roots.sort((a, b) => a.node.name.localeCompare(b.node.name));
  roots.forEach(sum);
  return roots;
}

export default function NodeTree({
  nodes,
  selected,
  onSelect,
  isAdmin,
  onCreate,
  onRename,
  onDelete,
}: {
  nodes: NodeData[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  isAdmin: boolean;
  onCreate: (parentId: string | null) => void;
  onRename: (node: NodeData) => void;
  onDelete: (node: NodeData) => void;
}) {
  const tree = useMemo(() => buildTree(nodes), [nodes]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const rowCls = (active: boolean) =>
    cn(
      "group flex h-8 cursor-pointer items-center gap-1.5 rounded-md pr-1 text-sm transition-colors",
      active ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
    );

  const renderItem = (it: TreeItem, depth: number) => {
    const open = !collapsed.has(it.node.id);
    const active = selected === it.node.id;
    const hasChildren = it.children.length > 0;
    return (
      <div key={it.node.id}>
        <div
          className={rowCls(active)}
          style={{ paddingLeft: 4 + depth * 14 }}
          onClick={() => onSelect(it.node.id)}
          title={it.node.description || it.node.path}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (hasChildren) toggle(it.node.id);
            }}
            className={cn("flex w-4 shrink-0 justify-center text-muted-foreground", !hasChildren && "invisible")}
            aria-label={open ? "Replier" : "Déplier"}
          >
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
          {open && hasChildren ? (
            <FolderOpen className="size-3.5 shrink-0" />
          ) : (
            <Folder className="size-3.5 shrink-0" />
          )}
          <span className="flex-1 truncate">{it.node.name}</span>
          {isAdmin && (
            <span className="hidden items-center group-hover:flex">
              <NodeAction title="Nouveau sous-nœud" onClick={() => onCreate(it.node.id)}>
                <FolderPlus className="size-3.5" />
              </NodeAction>
              <NodeAction title="Renommer" onClick={() => onRename(it.node)}>
                <Pencil className="size-3.5" />
              </NodeAction>
              <NodeAction title="Supprimer" danger onClick={() => onDelete(it.node)}>
                <Trash2 className="size-3.5" />
              </NodeAction>
            </span>
          )}
          <span className={cn("tabular text-xs text-muted-foreground", isAdmin && "group-hover:hidden")}>{it.total}</span>
        </div>
        {open && it.children.map((c) => renderItem(c, depth + 1))}
      </div>
    );
  };

  return (
    <div className="rounded-lg border bg-card p-2">
      <div className="mb-1 flex h-8 items-center justify-between px-2">
        <span className="text-xs font-medium text-muted-foreground">Arborescence</span>
        {isAdmin && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => onCreate(null)}
                className="size-7 text-muted-foreground"
                aria-label="Nouveau nœud racine"
              >
                <FolderPlus className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Nouveau nœud racine</TooltipContent>
          </Tooltip>
        )}
      </div>
      <div className={cn(rowCls(selected === null), "px-2")} onClick={() => onSelect(null)}>
        <Layers className="size-3.5" />
        <span className="flex-1">Tous les serveurs</span>
      </div>
      {tree.map((it) => renderItem(it, 0))}
      {tree.length === 0 && (
        <p className="px-2 py-2 text-xs text-muted-foreground">
          Aucun nœud.{isAdmin && " Créez-en un pour organiser vos serveurs."}
        </p>
      )}
    </div>
  );
}

function NodeAction({
  title,
  onClick,
  danger,
  children,
}: {
  title: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground",
        danger && "hover:text-danger",
      )}
      title={title}
      aria-label={title}
    >
      {children}
    </button>
  );
}

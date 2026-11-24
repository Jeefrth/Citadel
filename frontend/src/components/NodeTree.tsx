import { useMemo, useState } from "react";
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

  const renderItem = (it: TreeItem, depth: number) => {
    const open = !collapsed.has(it.node.id);
    const active = selected === it.node.id;
    const hasChildren = it.children.length > 0;
    return (
      <div key={it.node.id}>
        <div
          className={`group flex items-center gap-1 pr-1 py-1 rounded-md text-sm cursor-pointer ${
            active ? "bg-primary text-primary-foreground" : "hover:bg-accent"
          }`}
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
            className={`w-4 shrink-0 ${hasChildren ? "" : "invisible"}`}
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          {open && hasChildren ? (
            <FolderOpen size={14} className="shrink-0" />
          ) : (
            <Folder size={14} className="shrink-0" />
          )}
          <span className="truncate flex-1">{it.node.name}</span>
          {isAdmin && (
            <span className="hidden group-hover:flex items-center">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onCreate(it.node.id);
                }}
                className="p-0.5 rounded hover:bg-black/10"
                title="Nouveau sous-nœud"
              >
                <FolderPlus size={12} />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRename(it.node);
                }}
                className="p-0.5 rounded hover:bg-black/10"
                title="Renommer"
              >
                <Pencil size={12} />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(it.node);
                }}
                className="p-0.5 rounded hover:bg-black/10"
                title="Supprimer"
              >
                <Trash2 size={12} />
              </button>
            </span>
          )}
          <span
            className={`text-xs tabular-nums ${
              active ? "text-primary-foreground/80" : "text-muted-foreground"
            } group-hover:hidden`}
          >
            {it.total}
          </span>
        </div>
        {open && it.children.map((c) => renderItem(c, depth + 1))}
      </div>
    );
  };

  return (
    <div className="bg-card border rounded-lg p-2">
      <div className="flex items-center justify-between px-2 py-1 mb-1">
        <span className="text-xs font-medium text-muted-foreground uppercase">Arborescence</span>
        {isAdmin && (
          <button
            type="button"
            onClick={() => onCreate(null)}
            className="p-1 rounded hover:bg-accent text-muted-foreground"
            title="Nouveau nœud racine"
          >
            <FolderPlus size={14} />
          </button>
        )}
      </div>
      <div
        className={`flex items-center gap-2 px-2 py-1 rounded-md text-sm cursor-pointer ${
          selected === null ? "bg-primary text-primary-foreground" : "hover:bg-accent"
        }`}
        onClick={() => onSelect(null)}
      >
        <Layers size={14} />
        <span className="flex-1">Tous les serveurs</span>
      </div>
      {tree.map((it) => renderItem(it, 0))}
      {tree.length === 0 && (
        <p className="text-xs text-muted-foreground px-2 py-2">
          Aucun nœud.{isAdmin && " Créez-en un pour organiser vos serveurs."}
        </p>
      )}
    </div>
  );
}

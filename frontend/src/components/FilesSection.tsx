// SFTP file browser of a Linux server (lot 5, E1). Needs "upload" or "download".
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import {
  ArrowUp,
  Download,
  File as FileIcon,
  FileSymlink,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { ApiError, api, fetchBlob, postMultipart, saveBlob } from "@/services/api";
import {
  errorMessage,
  hasAction,
  type ConnectableAccount,
  type FileEntry,
  type FileListing,
  type ServerData,
  type UploadResult,
} from "@/services/types";
import { ConfirmModal, EmptyState, ErrorBox, Field, Modal, Notice, SaveButton, formatDate, type NoticeData } from "@/components/kit";
import { RowAction } from "@/components/AccountsSection";
import { formatSize } from "@/components/opsUi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

const accountKey = (a: ConnectableAccount) => a.id ?? a.virtual ?? a.username;

function parentOf(path: string): string {
  if (!path || path === "/") return "/";
  const i = path.replace(/\/+$/, "").lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

/** "/var/log/nginx" -> [{"/", "/"}, {"var", "/var"}, ...] */
function segmentsOf(path: string): { label: string; path: string }[] {
  const parts = path.split("/").filter(Boolean);
  const out = [{ label: "/", path: "/" }];
  parts.forEach((p, i) => out.push({ label: p, path: "/" + parts.slice(0, i + 1).join("/") }));
  return out;
}

const TYPE_ICON = { dir: Folder, file: FileIcon, link: FileSymlink, other: FileIcon };

interface UploadItem {
  id: string;
  name: string;
  progress: number;
}

export default function FilesSection({ server }: { server: ServerData }) {
  const [accounts, setAccounts] = useState<ConnectableAccount[] | null>(null);
  const [selected, setSelected] = useState("");
  const [listing, setListing] = useState<FileListing | null>(null);
  const [path, setPath] = useState(""); // requested path; "" = home of the account
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeData | null>(null);
  const [editingPath, setEditingPath] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [conflicts, setConflicts] = useState<File[]>([]);
  const [renaming, setRenaming] = useState<FileEntry | null>(null);
  const [removing, setRemoving] = useState<FileEntry | null>(null);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const chosen = accounts?.find((a) => accountKey(a) === selected) || null;
  const canUpload = listing ? listing.can_upload : hasAction(server, "upload");
  const canDownload = listing ? listing.can_download : hasAction(server, "download");

  // Account parameters, shared by every call
  const accountParams = useMemo((): Record<string, string> => {
    if (!chosen) return {};
    if (chosen.id) return { account_id: chosen.id };
    if (chosen.virtual) return { virtual_account: chosen.virtual };
    return {};
  }, [chosen]);

  useEffect(() => {
    let alive = true;
    api
      .get<ConnectableAccount[]>(`/api/servers/${server.id}/connectable-accounts`)
      .then((list) => {
        if (!alive) return;
        const usable = list.filter((a) => a.virtual !== "@INPUT");
        setAccounts(usable);
        const def = usable.find((a) => a.is_default) || usable[0];
        if (def) setSelected(accountKey(def));
      })
      .catch((e) => alive && (setAccounts([]), setError(errorMessage(e))));
    return () => {
      alive = false;
    };
  }, [server.id]);

  const load = useCallback(
    async (target: string) => {
      if (!chosen) return;
      setLoading(true);
      setError(null);
      const qs = new URLSearchParams({ ...accountParams, ...(target ? { path: target } : {}) });
      try {
        const res = await api.get<FileListing>(`/api/servers/${server.id}/files?${qs}`);
        setListing(res);
        setPath(res.path);
        setEditingPath(false);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [chosen, accountParams, server.id],
  );

  // New account: back to its home directory
  useEffect(() => {
    if (chosen) load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, accounts]);

  const entries = useMemo(() => {
    const list = [...(listing?.entries || [])];
    list.sort((a, b) => {
      const da = a.type === "dir" ? 0 : 1;
      const db = b.type === "dir" ? 0 : 1;
      return da - db || a.name.localeCompare(b.name, "fr", { sensitivity: "base" });
    });
    return list;
  }, [listing]);

  const open = (e: FileEntry) => {
    if (e.type === "dir" || e.type === "link") load(e.path);
  };

  const download = async (e: FileEntry) => {
    setBusy(e.path);
    try {
      const qs = new URLSearchParams({ ...accountParams, path: e.path });
      const blob = await fetchBlob(`/api/servers/${server.id}/files/download?${qs}`);
      saveBlob(blob, e.name);
      toast.success(`${e.name} téléchargé`);
    } catch (err) {
      setNotice({ ok: false, text: `Téléchargement de ${e.name} impossible : ${errorMessage(err)}` });
    } finally {
      setBusy(null);
    }
  };

  const uploadOne = async (file: File, overwrite: boolean): Promise<"ok" | "conflict" | "error"> => {
    if (!listing) return "error";
    const id = `${file.name}-${Date.now()}-${Math.random()}`;
    setUploads((u) => [...u, { id, name: file.name, progress: 0 }]);
    const form = new FormData();
    form.append("directory", listing.path);
    form.append("overwrite", overwrite ? "true" : "false");
    Object.entries(accountParams).forEach(([k, v]) => form.append(k, v));
    form.append("file", file, file.name);
    try {
      const res = await postMultipart<UploadResult>(`/api/servers/${server.id}/files/upload`, form, (p) =>
        setUploads((u) => u.map((x) => (x.id === id ? { ...x, progress: p } : x))),
      );
      toast.success(`${file.name} envoyé`, { description: `${formatSize(res.size)}, SHA-256 ${res.sha256.slice(0, 12)}…` });
      return "ok";
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) return "conflict";
      setNotice({ ok: false, text: `Envoi de ${file.name} impossible : ${errorMessage(err)}` });
      return "error";
    } finally {
      setUploads((u) => u.filter((x) => x.id !== id));
    }
  };

  const uploadFiles = async (files: File[]) => {
    if (!files.length || !listing) return;
    setNotice(null);
    const conflicting: File[] = [];
    let sent = 0;
    for (const f of files) {
      const r = await uploadOne(f, false);
      if (r === "conflict") conflicting.push(f);
      if (r === "ok") sent++;
    }
    if (sent) load(listing.path);
    if (conflicting.length) setConflicts(conflicting);
  };

  const replaceConflict = async () => {
    const [first, ...rest] = conflicts;
    if (!first) return;
    setConflicts(rest);
    const r = await uploadOne(first, true);
    if (r === "ok" && listing) load(listing.path);
  };

  const onDragEnter = (e: DragEvent) => {
    if (!canUpload || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragDepth.current++;
    setDragOver(true);
  };
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    if (!canUpload) return;
    uploadFiles(Array.from(e.dataTransfer.files));
  };

  const remove = async (e: FileEntry) => {
    setBusy(e.path);
    try {
      await api.post(`/api/servers/${server.id}/files/delete`, { path: e.path, ...accountParams });
      toast.success(`${e.name} supprimé`);
      setListing((l) => (l ? { ...l, entries: l.entries.filter((x) => x.path !== e.path) } : l));
      setRemoving(null);
    } catch (err) {
      setRemoving(null);
      setNotice({ ok: false, text: `Suppression de ${e.name} impossible : ${errorMessage(err)}` });
    } finally {
      setBusy(null);
    }
  };

  const onRowKey = (ev: KeyboardEvent, e: FileEntry) => {
    if (ev.key === "Enter") open(e);
  };

  const segments = listing ? segmentsOf(listing.path) : [];

  return (
    <section className="mt-8 overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b p-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <HardDrive className="size-4 text-muted-foreground" /> Fichiers
          </h2>
          <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">
            Parcourez le serveur en SFTP avec le compte choisi. Les droits du système de fichiers de ce compte
            s'appliquent et chaque transfert est tracé dans l'audit.
          </p>
        </div>
        {accounts && accounts.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Compte</span>
            <Select value={selected} onValueChange={setSelected}>
              <SelectTrigger className="h-8 w-56 font-mono text-xs">
                <SelectValue placeholder="Choisir un compte" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={accountKey(a)} value={accountKey(a)}>
                    <span className="font-mono">{a.username}</span>
                    {a.virtual === "@USER" && <span className="text-muted-foreground"> (certificat à votre nom)</span>}
                    {a.is_default && <span className="text-muted-foreground"> (par défaut)</span>}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {accounts === null ? (
        <div className="space-y-2 p-4">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : accounts.length === 0 ? (
        <div className="p-4">
          <ErrorBox message={error} />
          {!error && (
            <EmptyState icon={HardDrive} title="Aucun compte utilisable">
              Aucune règle d'accès ne vous donne un compte sur ce serveur. Les comptes saisis à la connexion
              (@INPUT) ne servent pas aux transferts.
            </EmptyState>
          )}
        </div>
      ) : (
        <>
          {/* Toolbar: path + actions */}
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              title="Dossier parent"
              aria-label="Dossier parent"
              disabled={!listing || listing.path === "/" || loading}
              onClick={() => listing && load(parentOf(listing.path))}
            >
              <ArrowUp />
            </Button>
            <div className="min-w-0 flex-1">
              {editingPath ? (
                <Input
                  autoFocus
                  value={pathInput}
                  onChange={(e) => setPathInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") load(pathInput.trim());
                    if (e.key === "Escape") setEditingPath(false);
                  }}
                  onBlur={() => setEditingPath(false)}
                  className="h-8 font-mono text-xs"
                  aria-label="Chemin"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setPathInput(listing?.path || path);
                    setEditingPath(true);
                  }}
                  title="Saisir un chemin"
                  className="group flex h-8 w-full min-w-0 items-center gap-0.5 overflow-x-auto rounded-md border border-input px-2 text-left font-mono text-xs"
                >
                  {segments.map((s, i) => (
                    <span key={s.path} className="flex shrink-0 items-center">
                      {i > 1 && <span className="px-0.5 text-muted-foreground">/</span>}
                      <span
                        role="link"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          load(s.path);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.stopPropagation();
                            load(s.path);
                          }
                        }}
                        className={cn(
                          "rounded px-1 py-0.5 hover:bg-muted",
                          i === segments.length - 1 ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {s.label}
                      </span>
                    </span>
                  ))}
                  <Pencil className="ml-auto size-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
                </button>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              title="Actualiser"
              aria-label="Actualiser"
              disabled={loading}
              onClick={() => load(listing?.path || path)}
            >
              <RefreshCw className={cn(loading && "animate-spin")} />
            </Button>
            {canUpload && (
              <>
                <Button variant="outline" size="sm" onClick={() => setMkdirOpen(true)} disabled={!listing}>
                  <FolderPlus /> Nouveau dossier
                </Button>
                <Button size="sm" onClick={() => fileInput.current?.click()} disabled={!listing}>
                  <Upload /> Envoyer des fichiers
                </Button>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const files = Array.from(e.target.files || []);
                    e.target.value = "";
                    uploadFiles(files);
                  }}
                />
              </>
            )}
          </div>

          {(error || notice || uploads.length > 0) && (
            <div className="space-y-2 px-4 pt-3">
              <Notice notice={notice} onClose={() => setNotice(null)} />
              <ErrorBox message={error} />
              <AnimatePresence initial={false}>
                {uploads.map((u) => (
                  <motion.div
                    key={u.id}
                    layout
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.18 }}
                    className="overflow-hidden"
                  >
                    <div className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm">
                      <Loader2 className="size-3.5 shrink-0 animate-spin text-live" />
                      <span className="min-w-0 truncate font-mono text-xs">{u.name}</span>
                      <Progress value={u.progress * 100} className="h-1 flex-1" />
                      <span className="tabular w-10 text-right text-xs text-muted-foreground">
                        {Math.round(u.progress * 100)} %
                      </span>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}

          <div
            className="relative"
            onDragEnter={onDragEnter}
            onDragOver={(e) => canUpload && e.preventDefault()}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            <AnimatePresence>
              {dragOver && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-info/50 bg-background/80 text-sm"
                >
                  <span className="flex items-center gap-2">
                    <Upload className="size-4 text-info" /> Déposez les fichiers pour les envoyer dans{" "}
                    <span className="font-mono">{listing?.path}</span>
                  </span>
                </motion.div>
              )}
            </AnimatePresence>

            {!listing && loading ? (
              <div className="space-y-2 p-4">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-9 w-full" />
                ))}
              </div>
            ) : !listing ? (
              <div className="p-4 text-sm text-muted-foreground">Choisissez un compte pour parcourir le serveur.</div>
            ) : entries.length === 0 ? (
              <div className="p-4">
                <EmptyState icon={FolderOpen} title="Dossier vide">
                  {canUpload ? "Glissez des fichiers ici ou utilisez « Envoyer des fichiers »." : "Ce dossier ne contient aucun fichier."}
                </EmptyState>
              </div>
            ) : (
              <Table className={cn(loading && "opacity-60 transition-opacity")}>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-4">Nom</TableHead>
                    <TableHead className="text-right">Taille</TableHead>
                    <TableHead>Droits</TableHead>
                    <TableHead>Propriétaire</TableHead>
                    <TableHead>Modifié le</TableHead>
                    <TableHead className="pr-4 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody key={listing.path}>
                  <AnimatePresence initial={false}>
                    {entries.map((e) => {
                      const Icon = TYPE_ICON[e.type] || FileIcon;
                      const isBusy = busy === e.path;
                      const openable = e.type === "dir" || e.type === "link";
                      return (
                        <motion.tr
                          key={e.path}
                          layout="position"
                          exit={{ opacity: 0, height: 0 }}
                          transition={{ duration: 0.18 }}
                          tabIndex={0}
                          onDoubleClick={() => open(e)}
                          onKeyDown={(ev) => onRowKey(ev, e)}
                          className="h-10 border-b outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/50"
                        >
                          <TableCell className="pl-4">
                            <span className="flex min-w-0 items-center gap-2">
                              <Icon
                                className={cn("size-4 shrink-0", e.type === "dir" ? "text-info" : "text-muted-foreground")}
                              />
                              {openable ? (
                                <button
                                  type="button"
                                  onClick={() => open(e)}
                                  className="truncate text-left font-mono text-xs hover:underline"
                                >
                                  {e.name}
                                </button>
                              ) : (
                                <span className="truncate font-mono text-xs">{e.name}</span>
                              )}
                            </span>
                          </TableCell>
                          <TableCell className="tabular text-right text-xs text-muted-foreground">
                            {e.type === "file" ? formatSize(e.size) : ""}
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">{e.mode}</TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {e.owner ?? "-"}
                            {e.group && e.group !== e.owner ? `:${e.group}` : ""}
                          </TableCell>
                          <TableCell className="tabular text-xs text-muted-foreground">
                            {e.mtime ? formatDate(new Date(e.mtime * 1000).toISOString()) : "-"}
                          </TableCell>
                          <TableCell className="pr-4 text-right">
                            <div className="flex items-center justify-end gap-0.5">
                              {e.type === "file" && canDownload && (
                                <RowAction label="Télécharger" onClick={() => download(e)} disabled={isBusy}>
                                  {isBusy ? <Loader2 className="animate-spin" /> : <Download />}
                                </RowAction>
                              )}
                              {canUpload && (
                                <>
                                  <RowAction label="Renommer ou déplacer" onClick={() => setRenaming(e)} disabled={isBusy}>
                                    <Pencil />
                                  </RowAction>
                                  <RowAction label="Supprimer" danger onClick={() => setRemoving(e)} disabled={isBusy}>
                                    <Trash2 />
                                  </RowAction>
                                </>
                              )}
                            </div>
                          </TableCell>
                        </motion.tr>
                      );
                    })}
                  </AnimatePresence>
                </TableBody>
              </Table>
            )}
          </div>
          {listing && (
            <p className="border-t px-4 py-2 text-xs text-muted-foreground">
              <span className="tabular">{entries.length}</span> élément{entries.length > 1 ? "s" : ""} · compte{" "}
              <span className="font-mono">{listing.account}</span>
              {canUpload && " · glissez des fichiers sur la liste pour les envoyer"}
            </p>
          )}
        </>
      )}

      {conflicts[0] && (
        <ConfirmModal
          title={
            <>
              Remplacer <span className="font-mono">{conflicts[0].name}</span>
            </>
          }
          confirmLabel="Remplacer"
          danger
          onClose={() => setConflicts((c) => c.slice(1))}
          onConfirm={replaceConflict}
        >
          <p>
            Un fichier du même nom existe déjà dans <strong className="font-mono">{listing?.path}</strong>. Le remplacer
            écrase son contenu sur le serveur.
          </p>
          {conflicts.length > 1 && (
            <p className="text-xs">
              {conflicts.length - 1} autre{conflicts.length > 2 ? "s" : ""} fichier{conflicts.length > 2 ? "s" : ""} en
              conflit après celui-ci.
            </p>
          )}
        </ConfirmModal>
      )}

      {removing && (
        <ConfirmModal
          title={
            <>
              Supprimer <span className="font-mono">{removing.name}</span>
            </>
          }
          confirmLabel="Supprimer"
          danger
          loading={busy === removing.path}
          onClose={() => setRemoving(null)}
          onConfirm={() => remove(removing)}
        >
          <p>
            <strong className="font-mono">{removing.path}</strong> sera supprimé du serveur {server.name}. Cette action
            est définitive.
          </p>
          {removing.type === "dir" && <p>Seul un dossier vide peut être supprimé.</p>}
        </ConfirmModal>
      )}

      {renaming && listing && (
        <RenameModal
          entry={renaming}
          onClose={() => setRenaming(null)}
          onSubmit={async (newPath) => {
            await api.post(`/api/servers/${server.id}/files/rename`, {
              path: renaming.path,
              new_path: newPath,
              ...accountParams,
            });
            toast.success(`${renaming.name} renommé`);
            setRenaming(null);
            load(listing.path);
          }}
        />
      )}

      {mkdirOpen && listing && (
        <MkdirModal
          dir={listing.path}
          onClose={() => setMkdirOpen(false)}
          onSubmit={async (name) => {
            await api.post(`/api/servers/${server.id}/files/mkdir`, {
              path: joinPath(listing.path, name),
              ...accountParams,
            });
            toast.success(`Dossier ${name} créé`);
            setMkdirOpen(false);
            load(listing.path);
          }}
        />
      )}
    </section>
  );
}

function RenameModal({
  entry,
  onClose,
  onSubmit,
}: {
  entry: FileEntry;
  onClose: () => void;
  onSubmit: (newPath: string) => Promise<void>;
}) {
  const [value, setValue] = useState(entry.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A bare name stays in the same folder; an absolute path moves the entry
  const target = value.startsWith("/") ? value.trim() : joinPath(parentOf(entry.path), value.trim());
  const valid = value.trim() !== "" && value.trim() !== entry.name && !/^\.\.?$/.test(value.trim());
  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit(target);
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  };
  return (
    <Modal
      title={
        <>
          Renommer <span className="font-mono">{entry.name}</span>
        </>
      }
      size="md"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <SaveButton onClick={submit} loading={saving} disabled={!valid}>
            Renommer
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <Field label="Nouveau nom" hint="Un nom seul reste dans le même dossier ; un chemin absolu déplace l'élément.">
        <Input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          className="font-mono"
        />
      </Field>
      <p className="text-xs text-muted-foreground">
        Destination : <span className="font-mono text-foreground">{target}</span>
      </p>
    </Modal>
  );
}

function MkdirModal({
  dir,
  onClose,
  onSubmit,
}: {
  dir: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = name.trim() !== "" && !name.includes("/") && !/^\.\.?$/.test(name.trim());
  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit(name.trim());
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  };
  return (
    <Modal
      title="Nouveau dossier"
      description={
        <>
          Dans <span className="font-mono">{dir}</span>
        </>
      }
      size="md"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <SaveButton onClick={submit} loading={saving} disabled={!valid}>
            Créer le dossier
          </SaveButton>
        </>
      }
    >
      <ErrorBox message={error} />
      <Field label="Nom du dossier">
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          className="font-mono"
          placeholder="releases"
        />
      </Field>
    </Modal>
  );
}

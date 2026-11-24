// Playbooks stored in Citadel (lot 5, E3). Everyone reads, admins write.
import { useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { Eye, FileCode2, Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "@/services/api";
import { errorMessage, type PlaybookData } from "@/services/types";
import { ConfirmModal, EmptyState, ErrorBox, Field, Modal, SaveButton, formatDate } from "@/components/kit";
import { TableSkeleton } from "@/components/auditUi";
import { RowAction } from "@/components/AccountsSection";
import { parseJsonObject } from "@/components/opsUi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const SAMPLE = `- hosts: all
  become: true
  tasks:
    - name: Paquets à jour
      ansible.builtin.apt:
        update_cache: true
        upgrade: safe
`;

export default function PlaybooksPanel({
  playbooks,
  isAdmin,
  onChanged,
}: {
  playbooks: PlaybookData[] | null;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  // undefined = closed, null = new
  const [editing, setEditing] = useState<PlaybookData | null | undefined>(undefined);
  const [removing, setRemoving] = useState<PlaybookData | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async (p: PlaybookData) => {
    setDeleting(true);
    try {
      await api.delete(`/api/playbooks/${p.id}`);
      toast.success(`Playbook ${p.name} supprimé`);
      setRemoving(null);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
      setRemoving(null);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Playbooks Ansible (YAML, <span className="font-mono">hosts: all</span>) lancés depuis une tâche. Les règles de
          commandes ne s'appliquent pas à leur contenu : seuls les administrateurs les écrivent.
        </p>
        {isAdmin && (
          <Button onClick={() => setEditing(null)}>
            <Plus /> Nouveau playbook
          </Button>
        )}
      </div>
      <ErrorBox message={error} />
      {playbooks && playbooks.length === 0 ? (
        <EmptyState
          icon={FileCode2}
          title="Aucun playbook"
          action={
            isAdmin ? (
              <Button variant="outline" onClick={() => setEditing(null)}>
                <Plus /> Nouveau playbook
              </Button>
            ) : undefined
          }
        >
          {isAdmin
            ? "Ajoutez un premier playbook pour l'utiliser dans une tâche."
            : "Un administrateur doit d'abord ajouter un playbook."}
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Nom</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Variables par défaut</TableHead>
                <TableHead>Créé le</TableHead>
                <TableHead className="pr-4 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!playbooks ? (
                <TableSkeleton rows={3} cols={5} />
              ) : (
                <AnimatePresence initial={false}>
                  {playbooks.map((p) => {
                    const varKeys = Object.keys(p.variables || {});
                    return (
                      <motion.tr
                        key={p.id}
                        layout="position"
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.18 }}
                        className="h-11 border-b transition-colors hover:bg-muted/50"
                      >
                        <TableCell className="pl-4 font-medium">{p.name}</TableCell>
                        <TableCell className="max-w-sm truncate text-xs text-muted-foreground">{p.description}</TableCell>
                        <TableCell className="max-w-xs truncate font-mono text-xs text-muted-foreground">
                          {varKeys.length ? varKeys.join(", ") : "-"}
                        </TableCell>
                        <TableCell className="tabular text-xs text-muted-foreground">{formatDate(p.created_at)}</TableCell>
                        <TableCell className="pr-4 text-right">
                          <div className="flex items-center justify-end gap-0.5">
                            {isAdmin ? (
                              <>
                                <RowAction label="Modifier" onClick={() => setEditing(p)}>
                                  <Pencil />
                                </RowAction>
                                <RowAction label="Supprimer" danger onClick={() => setRemoving(p)}>
                                  <Trash2 />
                                </RowAction>
                              </>
                            ) : (
                              <RowAction label="Voir le contenu" onClick={() => setEditing(p)}>
                                <Eye />
                              </RowAction>
                            )}
                          </div>
                        </TableCell>
                      </motion.tr>
                    );
                  })}
                </AnimatePresence>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {editing !== undefined && (
        <PlaybookModal
          playbook={editing}
          readOnly={!isAdmin}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            onChanged();
          }}
        />
      )}
      {removing && (
        <ConfirmModal
          title={`Supprimer le playbook ${removing.name}`}
          confirmLabel="Supprimer"
          danger
          loading={deleting}
          onClose={() => setRemoving(null)}
          onConfirm={() => remove(removing)}
        >
          <p>Les tâches déjà lancées avec ce playbook restent dans l'historique.</p>
        </ConfirmModal>
      )}
    </div>
  );
}

function PlaybookModal({
  playbook,
  readOnly,
  onClose,
  onSaved,
}: {
  playbook: PlaybookData | null;
  readOnly: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(playbook?.name || "");
  const [description, setDescription] = useState(playbook?.description || "");
  const [content, setContent] = useState(playbook?.content || SAMPLE);
  const [variables, setVariables] = useState(
    playbook && Object.keys(playbook.variables || {}).length ? JSON.stringify(playbook.variables, null, 2) : "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [vars, varsError] = parseJsonObject(variables);
  const valid = name.trim() !== "" && content.trim() !== "" && !varsError;

  const save = async () => {
    setSaving(true);
    setError(null);
    const body = { name: name.trim(), description: description.trim() || null, content, variables: vars || {} };
    try {
      if (playbook) await api.put(`/api/playbooks/${playbook.id}`, body);
      else await api.post("/api/playbooks", body);
      toast.success(playbook ? "Playbook enregistré" : "Playbook créé");
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={readOnly ? playbook?.name : playbook ? `Modifier ${playbook.name}` : "Nouveau playbook"}
      size="3xl"
      onClose={onClose}
      footer={
        readOnly ? (
          <Button variant="outline" onClick={onClose}>
            Fermer
          </Button>
        ) : (
          <>
            <Button variant="outline" onClick={onClose}>
              Annuler
            </Button>
            <SaveButton onClick={save} loading={saving} disabled={!valid}>
              Enregistrer le playbook
            </SaveButton>
          </>
        )
      }
    >
      <ErrorBox message={error} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Nom">
          <Input value={name} onChange={(e) => setName(e.target.value)} disabled={readOnly} placeholder="Mise à jour apt" />
        </Field>
        <Field label="Description">
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={readOnly}
            placeholder="Met à jour les paquets Debian et Ubuntu"
          />
        </Field>
      </div>
      <Field label="Contenu YAML" hint="Une liste de plays, chacun avec hosts: all. Citadel fournit l'inventaire des cibles.">
        <CodeEditor value={content} onChange={setContent} readOnly={readOnly} />
      </Field>
      <Field label="Variables par défaut (JSON)" hint="Facultatif. Remplaçables au lancement de la tâche.">
        <Textarea
          value={variables}
          onChange={(e) => setVariables(e.target.value)}
          readOnly={readOnly}
          rows={3}
          spellCheck={false}
          placeholder='{"upgrade": "safe"}'
          className={cn("font-mono text-xs", varsError && "border-danger/50")}
        />
        {varsError && <p className="text-xs text-danger">{varsError}</p>}
      </Field>
    </Modal>
  );
}

/** Monospace textarea with a line-number gutter (scroll kept in sync). */
function CodeEditor({ value, onChange, readOnly }: { value: string; onChange: (v: string) => void; readOnly?: boolean }) {
  const gutter = useRef<HTMLDivElement>(null);
  const lines = value.split("\n").length;
  return (
    <div className="flex h-80 overflow-hidden rounded-md border border-input focus-within:ring-1 focus-within:ring-ring">
      <div
        ref={gutter}
        aria-hidden
        className="tabular select-none overflow-hidden border-r bg-muted/40 px-2 py-2 text-right font-mono text-xs leading-5 text-muted-foreground"
      >
        {Array.from({ length: lines }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => {
          if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
        }}
        onKeyDown={(e) => {
          // Tab inserts two spaces (YAML indentation) instead of leaving the field
          if (e.key === "Tab" && !e.shiftKey && !readOnly) {
            e.preventDefault();
            const el = e.currentTarget;
            const { selectionStart: s, selectionEnd: end } = el;
            const next = value.slice(0, s) + "  " + value.slice(end);
            onChange(next);
            requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
          }
        }}
        readOnly={readOnly}
        spellCheck={false}
        wrap="off"
        aria-label="Contenu YAML"
        className="min-w-0 flex-1 resize-none bg-transparent px-3 py-2 font-mono text-xs leading-5 focus:outline-none"
      />
    </div>
  );
}

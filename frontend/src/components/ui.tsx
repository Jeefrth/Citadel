// Small shared UI building blocks, styled like the existing pages
// (plain Tailwind, same classes as the historical modals and forms).
import { useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, Check, CheckCircle2, Loader2, Plus, Search, X, type LucideIcon } from "lucide-react";

export const inputCls =
  "w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring";
export const btnPrimary =
  "flex items-center justify-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50";
export const btnSecondary =
  "flex items-center justify-center gap-2 px-4 py-2 rounded-md border text-sm hover:bg-accent disabled:opacity-50";
export const iconBtn = "p-1.5 rounded hover:bg-accent text-muted-foreground disabled:opacity-40";
export const iconBtnDanger =
  "p-1.5 rounded hover:bg-red-50 text-muted-foreground hover:text-red-600 disabled:opacity-40";

export function Modal({
  title,
  onClose,
  children,
  footer,
  size = "lg",
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "2xl" | "3xl";
}) {
  const width = {
    sm: "max-w-sm",
    md: "max-w-md",
    lg: "max-w-lg",
    "2xl": "max-w-2xl",
    "3xl": "max-w-3xl",
  }[size];
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className={`bg-card border rounded-lg shadow-lg w-full ${width} mx-4 max-h-[90vh] flex flex-col`}>
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="font-semibold">{title}</h3>
          <button onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="p-4 space-y-4 overflow-auto">{children}</div>
        {footer && <div className="flex justify-end gap-2 p-4 border-t">{footer}</div>}
      </div>
    </div>
  );
}

export function ErrorBox({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="p-2 rounded bg-red-50 text-red-700 text-sm">{message}</div>;
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium mb-1">{label}</label>
      {children}
      {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
    </div>
  );
}

export function SaveButton({
  onClick,
  loading,
  disabled,
  children = "Enregistrer",
}: {
  onClick: () => void;
  loading?: boolean;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <button onClick={onClick} disabled={loading || disabled} className={btnPrimary}>
      {loading ? <Loader2 size={16} className="animate-spin" /> : children}
    </button>
  );
}

export type ChipTone = "default" | "primary" | "amber" | "blue" | "green" | "red" | "orange";

export function Chip({
  children,
  onRemove,
  tone = "default",
  title,
}: {
  children: ReactNode;
  onRemove?: () => void;
  tone?: ChipTone;
  title?: string;
}) {
  const tones = {
    default: "bg-secondary text-secondary-foreground",
    primary: "bg-primary/10 text-primary",
    amber: "bg-amber-100 text-amber-800",
    blue: "bg-blue-100 text-blue-800",
    green: "bg-green-100 text-green-800",
    red: "bg-red-100 text-red-800",
    orange: "bg-orange-100 text-orange-800",
  };
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${tones[tone]}`}
    >
      {children}
      {onRemove && (
        <button type="button" onClick={onRemove} className="hover:opacity-70">
          <X size={11} />
        </button>
      )}
    </span>
  );
}

/** Flat {key: value} map shown as key=value chips. */
export function LabelChips({ tags }: { tags: Record<string, string> | null | undefined }) {
  const entries = Object.entries(tags || {});
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([k, v]) => (
        <Chip key={k}>
          {k}
          {v !== "" && <>={v}</>}
        </Chip>
      ))}
    </div>
  );
}

/** Editor for a flat {key: value} label map (chips + key/value inputs). */
export function LabelEditor({
  value,
  onChange,
  suggestions,
}: {
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  suggestions?: Record<string, string[]>;
}) {
  const [k, setK] = useState("");
  const [v, setV] = useState("");
  const add = () => {
    const key = k.trim();
    if (!key) return;
    onChange({ ...value, [key]: v.trim() });
    setK("");
    setV("");
  };
  const remove = (key: string) => {
    const next = { ...value };
    delete next[key];
    onChange(next);
  };
  const keyList = Object.keys(suggestions || {});
  const valueList = (suggestions || {})[k.trim()] || [];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1 min-h-[1.5rem]">
        {Object.entries(value).length === 0 && (
          <span className="text-xs text-muted-foreground">Aucune étiquette</span>
        )}
        {Object.entries(value).map(([key, val]) => (
          <Chip key={key} onRemove={() => remove(key)}>
            {key}
            {val !== "" && <>={val}</>}
          </Chip>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          list="label-keys"
          value={k}
          onChange={(e) => setK(e.target.value)}
          placeholder="clé (ex. env)"
          className={inputCls}
        />
        <input
          list="label-values"
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="valeur (ex. prod)"
          className={inputCls}
        />
        <button type="button" onClick={add} disabled={!k.trim()} className={btnSecondary} title="Ajouter">
          <Plus size={16} />
        </button>
        <datalist id="label-keys">
          {keyList.map((x) => (
            <option key={x} value={x} />
          ))}
        </datalist>
        <datalist id="label-values">
          {valueList.map((x) => (
            <option key={x} value={x} />
          ))}
        </datalist>
      </div>
    </div>
  );
}

export interface Option {
  id: string;
  label: string;
  sub?: string;
}

/** Searchable checkbox list; selected items are shown as chips above it. */
export function MultiSelect({
  options,
  selected,
  onChange,
  placeholder = "Rechercher...",
  emptyText = "Aucun élément",
  maxHeight = "max-h-40",
}: {
  options: Option[];
  selected: string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
  emptyText?: string;
  maxHeight?: string;
}) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(s) || (o.sub || "").toLowerCase().includes(s)
    );
  }, [options, q]);
  const byId = useMemo(() => new Map(options.map((o) => [o.id, o])), [options]);
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  return (
    <div className="border rounded-md">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1 p-2 border-b">
          {selected.map((id) => (
            <Chip key={id} tone="primary" onRemove={() => toggle(id)}>
              {byId.get(id)?.label || id.slice(0, 8)}
            </Chip>
          ))}
        </div>
      )}
      <div className="relative border-b">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={placeholder}
          className="w-full pl-8 pr-3 py-1.5 text-sm bg-transparent focus:outline-none"
        />
      </div>
      <div className={`${maxHeight} overflow-auto p-1`}>
        {filtered.length === 0 && <p className="text-xs text-muted-foreground p-2">{emptyText}</p>}
        {filtered.map((o) => {
          const on = selected.includes(o.id);
          return (
            <button
              type="button"
              key={o.id}
              onClick={() => toggle(o.id)}
              className="w-full flex items-center gap-2 px-2 py-1 rounded text-left text-sm hover:bg-accent"
            >
              <span
                className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                  on ? "bg-primary border-primary text-primary-foreground" : ""
                }`}
              >
                {on && <Check size={12} />}
              </span>
              <span className="truncate">{o.label}</span>
              {o.sub && <span className="text-xs text-muted-foreground truncate ml-auto">{o.sub}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: string; icon?: LucideIcon }[];
  active: T;
  onChange: (t: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 border-b mb-6">
      {tabs.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          className={`flex items-center gap-2 px-4 py-2 text-sm border-b-2 -mb-px transition-colors ${
            active === id
              ? "border-primary text-foreground font-medium"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          {Icon && <Icon size={16} />}
          {label}
        </button>
      ))}
    </div>
  );
}

export function formatDate(iso: string | null | undefined, withTime = true): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return withTime
    ? d.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })
    : d.toLocaleDateString("fr-FR");
}

/** Dismissible success / error banner (same look as the connection test banner). */
export interface NoticeData {
  ok: boolean;
  text: ReactNode;
}

export function Notice({ notice, onClose }: { notice: NoticeData | null; onClose: () => void }) {
  if (!notice) return null;
  return (
    <div
      className={`p-3 rounded-md text-sm flex items-start justify-between gap-3 ${
        notice.ok
          ? "bg-green-50 text-green-800 border border-green-200"
          : "bg-red-50 text-red-800 border border-red-200"
      }`}
    >
      <div className="flex items-start gap-2 min-w-0">
        {notice.ok ? (
          <CheckCircle2 size={16} className="shrink-0 mt-0.5" />
        ) : (
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
        )}
        <div className="break-words min-w-0">{notice.text}</div>
      </div>
      <button onClick={onClose} className="shrink-0" title="Fermer">
        <X size={14} />
      </button>
    </div>
  );
}

/** Confirmation dialog for impactful actions (richer than window.confirm). */
export function ConfirmModal({
  title,
  children,
  confirmLabel = "Confirmer",
  danger = false,
  loading = false,
  onConfirm,
  onClose,
}: {
  title: ReactNode;
  children: ReactNode;
  confirmLabel?: ReactNode;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={loading ? () => {} : onClose}
      size="md"
      footer={
        <>
          <button onClick={onClose} disabled={loading} className={btnSecondary}>
            Annuler
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className={
              danger
                ? "flex items-center justify-center gap-2 px-4 py-2 bg-red-600 text-white rounded-md text-sm font-medium hover:bg-red-700 disabled:opacity-50"
                : btnPrimary
            }
          >
            {loading && <Loader2 size={16} className="animate-spin" />}
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="text-sm space-y-2">{children}</div>
    </Modal>
  );
}

/** On / off switch with a label. */
export function Toggle({
  checked,
  onChange,
  disabled,
  label,
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: ReactNode;
  title?: string;
}) {
  return (
    <label
      title={title}
      className={`flex items-center gap-2 text-sm ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
          checked ? "bg-primary" : "bg-muted-foreground/30"
        }`}
      >
        <span
          className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>
      {label}
    </label>
  );
}

// Citadel UI kit: the app's shared building blocks, built on shadcn/ui + motion.
// The exported API is unchanged from the historical kit so every page benefits.
// Colour carries state only (see tailwind.config.js): live / success / danger / info.
import { useId, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, Check, CheckCircle2, Loader2, Plus, Search, X, type LucideIcon } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

// Legacy class helpers, now aligned on the shadcn primitives
export const inputCls =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";
export const btnPrimary = buttonVariants({ variant: "default" });
export const btnSecondary = buttonVariants({ variant: "outline" });
export const iconBtn = cn(buttonVariants({ variant: "ghost", size: "icon" }), "size-8 text-muted-foreground");
export const iconBtnDanger = cn(
  buttonVariants({ variant: "ghost", size: "icon" }),
  "size-8 text-muted-foreground hover:bg-danger/10 hover:text-danger",
);

export function Modal({
  title,
  onClose,
  children,
  footer,
  size = "lg",
  description,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "2xl" | "3xl";
  description?: ReactNode;
}) {
  const width = { sm: "sm:max-w-sm", md: "sm:max-w-md", lg: "sm:max-w-lg", "2xl": "sm:max-w-2xl", "3xl": "sm:max-w-3xl" }[size];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={cn("flex max-h-[90vh] flex-col gap-0 p-0", width)}>
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="text-base">{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : (
            <DialogDescription className="sr-only">{typeof title === "string" ? title : "Fenêtre"}</DialogDescription>
          )}
        </DialogHeader>
        <div className="space-y-4 overflow-auto px-5 py-4">{children}</div>
        {footer && <DialogFooter className="gap-2 border-t px-5 py-3 sm:gap-2">{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}

export function ErrorBox({ message }: { message: string | null }) {
  return (
    <AnimatePresence initial={false}>
      {message && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          className="overflow-hidden"
        >
          <div className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 break-words">{message}</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm font-medium">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
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
    <Button onClick={onClick} disabled={loading || disabled}>
      {loading && <Loader2 className="animate-spin" />}
      {children}
    </Button>
  );
}

export type ChipTone = "default" | "primary" | "amber" | "blue" | "green" | "red" | "orange";

const CHIP_TONES: Record<ChipTone, string> = {
  default: "bg-secondary text-secondary-foreground border-transparent",
  primary: "bg-foreground/10 text-foreground border-transparent",
  amber: "bg-live/10 text-live border-live/25",          // live, pending review
  orange: "bg-live/20 text-live border-live/40",          // alert (stronger amber)
  blue: "bg-info/10 text-info border-info/25",
  green: "bg-success/10 text-success border-success/25",
  red: "bg-danger/10 text-danger border-danger/25",
};

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
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 text-xs font-medium",
        CHIP_TONES[tone],
      )}
    >
      {children}
      {onRemove && (
        <button type="button" onClick={onRemove} className="-mr-0.5 rounded hover:opacity-70" aria-label="Retirer">
          <X className="size-3" />
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
          <span className="font-mono">
            {k}
            {v !== "" && <span className="text-muted-foreground">={v}</span>}
          </span>
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
  const uid = useId();
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
      <div className="flex min-h-6 flex-wrap gap-1">
        {Object.entries(value).length === 0 && <span className="text-xs text-muted-foreground">Aucune étiquette</span>}
        <AnimatePresence initial={false}>
          {Object.entries(value).map(([key, val]) => (
            <motion.span key={key} layout initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}>
              <Chip onRemove={() => remove(key)}>
                <span className="font-mono">
                  {key}
                  {val !== "" && <span className="text-muted-foreground">={val}</span>}
                </span>
              </Chip>
            </motion.span>
          ))}
        </AnimatePresence>
      </div>
      <div className="flex gap-2">
        <Input list={`${uid}-k`} value={k} onChange={(e) => setK(e.target.value)} placeholder="clé (ex. env)" className="font-mono" />
        <Input
          list={`${uid}-v`}
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="valeur (ex. prod)"
          className="font-mono"
        />
        <Button type="button" variant="outline" size="icon" onClick={add} disabled={!k.trim()} title="Ajouter l'étiquette">
          <Plus />
        </Button>
        <datalist id={`${uid}-k`}>
          {keyList.map((x) => (
            <option key={x} value={x} />
          ))}
        </datalist>
        <datalist id={`${uid}-v`}>
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
    return options.filter((o) => o.label.toLowerCase().includes(s) || (o.sub || "").toLowerCase().includes(s));
  }, [options, q]);
  const byId = useMemo(() => new Map(options.map((o) => [o.id, o])), [options]);
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  return (
    <div className="overflow-hidden rounded-md border border-input">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1 border-b bg-muted/40 p-2">
          {selected.map((id) => (
            <Chip key={id} tone="primary" onRemove={() => toggle(id)}>
              {byId.get(id)?.label || id.slice(0, 8)}
            </Chip>
          ))}
        </div>
      )}
      <div className="relative border-b">
        <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={placeholder}
          className="w-full bg-transparent py-2 pl-8 pr-3 text-sm placeholder:text-muted-foreground focus:outline-none"
        />
      </div>
      <div className={cn(maxHeight, "overflow-auto p-1")}>
        {filtered.length === 0 && <p className="p-2 text-xs text-muted-foreground">{emptyText}</p>}
        {filtered.map((o) => {
          const on = selected.includes(o.id);
          return (
            <button
              type="button"
              key={o.id}
              onClick={() => toggle(o.id)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
            >
              <span
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input transition-colors",
                  on && "border-primary bg-primary text-primary-foreground",
                )}
              >
                {on && <Check className="size-3" />}
              </span>
              <span className="truncate">{o.label}</span>
              {o.sub && <span className="ml-auto truncate text-xs text-muted-foreground">{o.sub}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Underlined tabs; the indicator slides to the active tab. */
export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: string; icon?: LucideIcon }[];
  active: T;
  onChange: (t: T) => void;
}) {
  const group = useId();
  return (
    <div className="mb-6 flex flex-wrap gap-1 border-b" role="tablist">
      {tabs.map(({ id, label, icon: Icon }) => {
        const on = active === id;
        return (
          <button
            key={id}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(id)}
            className={cn(
              "relative flex items-center gap-2 px-3 pb-2.5 pt-1.5 text-sm transition-colors",
              on ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {Icon && <Icon className="size-4" />}
            {label}
            {on && (
              <motion.span
                layoutId={`tab-${group}`}
                className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-foreground"
                transition={{ type: "spring", stiffness: 500, damping: 40 }}
              />
            )}
          </button>
        );
      })}
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

/** Dismissible success / error banner. */
export interface NoticeData {
  ok: boolean;
  text: ReactNode;
}

export function Notice({ notice, onClose }: { notice: NoticeData | null; onClose: () => void }) {
  return (
    <AnimatePresence initial={false}>
      {notice && (
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.18 }}
          role="status"
          className={cn(
            "flex items-start justify-between gap-3 rounded-md border px-3 py-2.5 text-sm",
            notice.ok ? "border-success/30 bg-success/10 text-success" : "border-danger/30 bg-danger/10 text-danger",
          )}
        >
          <div className="flex min-w-0 items-start gap-2">
            {notice.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
            <div className="min-w-0 break-words text-foreground">{notice.text}</div>
          </div>
          <button onClick={onClose} className="shrink-0 opacity-70 hover:opacity-100" aria-label="Fermer">
            <X className="size-4" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Confirmation dialog for impactful actions. */
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
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Annuler
          </Button>
          <Button variant={danger ? "destructive" : "default"} onClick={onConfirm} disabled={loading}>
            {loading && <Loader2 className="animate-spin" />}
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-sm text-muted-foreground [&_strong]:text-foreground">{children}</div>
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
  const id = useId();
  return (
    <div title={title} className={cn("flex items-center gap-2 text-sm", disabled && "opacity-50")}>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
      <label htmlFor={id} className={disabled ? "cursor-not-allowed" : "cursor-pointer"}>
        {label}
      </label>
    </div>
  );
}

/** Page title + one sentence saying what the page is for + actions on the right. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Empty state: say what to do, and offer the button that does it. */
export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center">
      {Icon && <Icon className="size-8 text-muted-foreground/60" strokeWidth={1.5} />}
      <div className="space-y-1">
        <p className="text-base font-medium">{title}</p>
        {children && <p className="max-w-md text-sm text-muted-foreground">{children}</p>}
      </div>
      {action}
    </div>
  );
}

// Shared bits for values shown once (keys, tokens) and for commands to copy (lot 7).
import { useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** Copy to the clipboard; the icon confirms the copy (motion in response to the click). */
export function CopyButton({ value, label = "Copier", className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable (non-secure context): the text can still be selected
    }
  };
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      className={cn("size-8 shrink-0", className)}
      onClick={copy}
      title={copied ? "Copié" : label}
      aria-label={label}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={copied ? "ok" : "copy"}
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8 }}
          transition={{ duration: 0.15 }}
        >
          {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
        </motion.span>
      </AnimatePresence>
    </Button>
  );
}

/** A command or technical value on one line, with a copy button. */
export function CopyLine({ value, label }: { value: string; label?: string }) {
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md border bg-muted/50 px-3 py-1.5 font-mono text-xs">
        {value}
      </code>
      <CopyButton value={value} label={label} />
    </div>
  );
}

/** Secret shown once: read-only field + copy button. */
export function SecretField({ value, label = "Copier" }: { value: string; label?: string }) {
  return (
    <div className="flex gap-2">
      <Input readOnly value={value} onFocus={(e) => e.target.select()} className="font-mono text-xs" />
      <CopyButton value={value} label={label} className="size-9" />
    </div>
  );
}

/** Amber warning: "copy it now, it will not be shown again". */
export function OnceWarning({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex gap-2 rounded-md border border-live/30 bg-live/10 px-3 py-2.5 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-live" />
      <div>
        <p className="font-medium text-live">{title}</p>
        {children && <div className="mt-1 text-xs text-foreground">{children}</div>}
      </div>
    </div>
  );
}

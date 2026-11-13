"use client";
import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

export type FormState = { ok?: boolean; message?: string; error?: string; redirect?: string; n?: number };
type Action = (prev: FormState, fd: FormData) => Promise<FormState>;

export function toast(kind: "ok" | "error", message: string) {
  window.dispatchEvent(new CustomEvent("app-toast", { detail: { kind, message } }));
}

export function Toaster() {
  const [items, setItems] = useState<{ id: number; kind: string; message: string }[]>([]);
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail as { kind: string; message: string };
      const id = Date.now() + Math.random();
      setItems((x) => [...x.slice(-3), { id, ...d }]);
      setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 5000);
    };
    window.addEventListener("app-toast", h);
    return () => window.removeEventListener("app-toast", h);
  }, []);
  return (
    <div className="fixed bottom-4 right-4 left-4 sm:left-auto z-[100] flex flex-col gap-2 sm:w-96 no-print" role="status" aria-live="polite">
      {items.map((i) => (
        <div key={i.id} className={`card card-pad shadow-lg border-l-4 ${i.kind === "ok" ? "border-l-ok" : "border-l-danger"}`}>
          <p className="text-sm font-medium">{i.kind === "ok" ? "Done" : "Could not complete"}</p>
          <p className="text-sm text-muted">{i.message}</p>
        </div>
      ))}
    </div>
  );
}

export function ActionForm({ action, children, submit = "Save", className = "", onSuccess, reset = true, danger = false, hideSubmit = false, inline = false }: {
  action: Action; children?: ReactNode; submit?: string; className?: string; onSuccess?: () => void; reset?: boolean; danger?: boolean; hideSubmit?: boolean; inline?: boolean;
}) {
  const [state, run, pending] = useActionState<FormState, FormData>(action, {});
  const ref = useRef<HTMLFormElement>(null);
  const router = useRouter();
  useEffect(() => {
    if (state.ok) {
      toast("ok", state.message ?? "Saved");
      if (reset) ref.current?.reset();
      onSuccess?.();
      if (state.redirect) router.push(state.redirect);
      else router.refresh();
    } else if (state.error) toast("error", state.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  return (
    <form ref={ref} action={run} className={`${inline ? "flex items-end gap-2 flex-wrap" : "space-y-3"} ${className}`}>
      {children}
      {state.error && !inline && <p role="alert" className="text-sm text-danger bg-danger/10 border border-danger/30 rounded-lg px-3 py-2">{state.error}</p>}
      {!hideSubmit && (
        <button type="submit" disabled={pending} className={`btn ${danger ? "btn-danger" : "btn-primary"}`}>
          {pending ? "Working..." : submit}
        </button>
      )}
    </form>
  );
}

export function Modal({ trigger, title, children, wide, variant = "primary", small, openState }: {
  trigger: string; title: string; children: (close: () => void) => ReactNode; wide?: boolean; variant?: "primary" | "default" | "danger"; small?: boolean; openState?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(!!openState);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  const cls = variant === "primary" ? "btn-primary" : variant === "danger" ? "btn-danger" : "";
  return (
    <>
      <button type="button" className={`btn ${cls} ${small ? "btn-sm" : ""}`} onClick={() => setOpen(true)}>{trigger}</button>
      <dialog ref={ref} className={`modal ${wide ? "wide" : ""}`} onClose={() => setOpen(false)} onClick={(e) => { if (e.target === ref.current) setOpen(false); }}>
        {open && (
          <div>
            <div className="flex items-center justify-between px-5 py-3 border-b border-line">
              <h2 className="font-semibold text-base">{title}</h2>
              <button type="button" className="btn btn-sm" onClick={() => setOpen(false)} aria-label="Close">Close</button>
            </div>
            <div className="p-5 overflow-y-auto" style={{ maxHeight: "calc(100dvh - 140px)" }}>{children(() => setOpen(false))}</div>
          </div>
        )}
      </dialog>
    </>
  );
}

export function ModalForm({ trigger, title, action, submit, children, wide, variant, small, danger }: {
  trigger: string; title: string; action: Action; submit?: string; children: ReactNode; wide?: boolean; variant?: "primary" | "default" | "danger"; small?: boolean; danger?: boolean;
}) {
  return (
    <Modal trigger={trigger} title={title} wide={wide} variant={variant} small={small}>
      {(close) => <ActionForm action={action} submit={submit ?? "Save"} onSuccess={close} danger={danger}>{children}</ActionForm>}
    </Modal>
  );
}

/** Confirmation dialog for sensitive operations. Optionally requires a written reason. */
export function ConfirmAction({ action, fields, label, title, message, submit, danger, reason, reasonLabel, variant = "default" }: {
  action: Action; fields: Record<string, string>; label: string; title?: string; message: string; submit?: string; danger?: boolean; reason?: boolean; reasonLabel?: string; variant?: "primary" | "default" | "danger";
}) {
  return (
    <Modal trigger={label} title={title ?? label} small variant={danger ? "danger" : variant}>
      {(close) => (
        <ActionForm action={action} submit={submit ?? label} onSuccess={close} danger={danger}>
          {Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
          <p className="text-sm text-muted">{message}</p>
          {reason && (
            <div>
              <label className="lbl" htmlFor="reason">{reasonLabel ?? "Reason (recorded in the audit trail)"}</label>
              <textarea id="reason" name="reason" required minLength={5} className="input" />
            </div>
          )}
        </ActionForm>
      )}
    </Modal>
  );
}

export function Field({ label, name, type = "text", required, placeholder, defaultValue, hint, step, min, max, children, pattern, inputMode }: {
  label: string; name: string; type?: string; required?: boolean; placeholder?: string; defaultValue?: string | number | null; hint?: string; step?: string; min?: string | number; max?: string | number; children?: ReactNode; pattern?: string; inputMode?: "numeric" | "tel" | "email" | "text" | "decimal";
}) {
  return (
    <div>
      <label className="lbl" htmlFor={name}>{label}{required && <span className="text-danger"> *</span>}</label>
      {children ?? <input id={name} name={name} type={type} required={required} placeholder={placeholder} defaultValue={defaultValue ?? undefined} step={step} min={min} max={max} pattern={pattern} inputMode={inputMode} className="input" />}
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}
export function Select({ label, name, options, required, defaultValue, hint }: { label: string; name: string; options: { value: string; label: string }[]; required?: boolean; defaultValue?: string; hint?: string }) {
  return (
    <Field label={label} name={name} required={required} hint={hint}>
      <select id={name} name={name} required={required} defaultValue={defaultValue} className="input">
        {!required && <option value="">-</option>}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Field>
  );
}
export const Grid = ({ children, cols = 2 }: { children: ReactNode; cols?: 1 | 2 | 3 }) => (
  <div className={`grid gap-3 grid-cols-1 ${cols === 2 ? "sm:grid-cols-2" : cols === 3 ? "sm:grid-cols-3" : ""}`}>{children}</div>
);

export function ThemeToggle() {
  return (
    <button type="button" className="btn btn-sm" aria-label="Toggle light or dark mode" onClick={() => {
      const dark = document.documentElement.classList.toggle("dark");
      localStorage.setItem("theme", dark ? "dark" : "light");
    }}>Theme</button>
  );
}

/** Optimistic mark-as-read toggle (non-financial, safe to update before the server confirms). */
export function OptimisticRead({ id, read, action }: { id: string; read: boolean; action: (id: string) => Promise<void> }) {
  const [isRead, setRead] = useState(read);
  return isRead ? <span className="badge">Read</span> : (
    <button className="btn btn-sm" onClick={async () => { setRead(true); try { await action(id); } catch { setRead(false); } }}>Mark read</button>
  );
}

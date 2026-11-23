"use client";
// Small shared pieces: the line drawings, product picture, modal, toast.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { photoUrl, type Product } from "@/lib/catalog";

const ART: Record<string, ReactNode> = {
  "jic-cap": (
    <>
      <path d="M44 16h34l7 7v34l-7 7H44l-7-7V23z" />
      <path d="M53 16v48M69 16v48" />
      <path d="M37 30h-5v20h5" />
    </>
  ),
  "jic-plug": (
    <>
      <path d="M16 34l11-8h31v28H27l-11-8z" />
      <path d="M33 26v28M39 26v28M45 26v28M51 26v28" />
      <path d="M58 16h30l7 7v34l-7 7H58z" />
      <path d="M70 16v48M83 16v48" />
    </>
  ),
  "orb-plug": (
    <>
      <path d="M25 16h26v48H25l-7-7V23z" />
      <path d="M33 16v48M43 16v48" />
      <path d="M51 24h6v32h-6" />
      <circle cx="61" cy="27" r="3.6" />
      <circle cx="61" cy="53" r="3.6" />
      <path d="M65 28h35v24H65z" />
      <path d="M71 28v24M77 28v24M83 28v24M89 28v24M95 28v24" />
    </>
  ),
  "breather-plug": (
    <>
      <path d="M31 17h14v46H31a9 9 0 0 1-9-9V26a9 9 0 0 1 9-9z" />
      <circle cx="33" cy="40" r="3.2" />
      <path d="M45 23l48 5v24l-48 5z" />
      <path d="M53 24v32M61 25v30M69 26v28M77 26.5v27M85 27.5v25" />
    </>
  ),
  adapter: (
    <>
      <path d="M46 16h28l7 7v34l-7 7H46l-7-7V23z" />
      <path d="M54 16v48M66 16v48" />
      <path d="M39 28H15v24h24" />
      <path d="M21 28v24M27 28v24M33 28v24" />
      <path d="M81 28h24v24H81" />
      <path d="M87 28v24M93 28v24M99 28v24" />
    </>
  ),
};

export function FittingArt({ type }: { type: string }) {
  return (
    <svg
      viewBox="0 0 120 80"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
    >
      {ART[type] ?? ART.adapter}
    </svg>
  );
}

/** First photo if there is one and it loads; otherwise the line drawing. */
export function Picture({ product, path, alt = "" }: { product: Product; path?: string; alt?: string }) {
  const src = path ?? product.photos[0];
  const [broken, setBroken] = useState<string | null>(null);
  if (!src || broken === src) return <FittingArt type={product.type} />;
  // eslint-disable-next-line @next/next/no-img-element -- photos are already sized on upload
  return <img src={photoUrl(src)} alt={alt} loading="lazy" onError={() => setBroken(src)} />;
}

export function Modal({
  open,
  onClose,
  title,
  sheet,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  sheet?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (open && !dlg.open) dlg.showModal();
    if (!open && dlg.open) dlg.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={sheet ? "sheet" : undefined}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="dlg">
          <div className="dlg-head">
            <h2>{title}</h2>
            <button type="button" className="x" aria-label="Close" onClick={onClose}>
              ×
            </button>
          </div>
          <div className="dlg-body">{children}</div>
          {footer && <div className="dlg-foot">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

export type ToastState = { text: string; bad?: boolean; at: number } | null;

export function Toast({ toast, clear }: { toast: ToastState; clear: () => void }) {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(clear, toast.bad ? 5500 : 2500);
    return () => clearTimeout(t);
  }, [toast, clear]);
  if (!toast) return null;
  return (
    <div id="toast" role="status" aria-live="polite" className={toast.bad ? "bad" : undefined}>
      {toast.text}
    </div>
  );
}

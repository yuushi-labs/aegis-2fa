import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useEscape } from '../lib/hooks';

export type ModalProps = {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** 幅の上限 */
  width?: 'sm' | 'md' | 'lg';
  describedBy?: string;
};

const WIDTH_CLASS: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-2xl',
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ open, title, onClose, children, footer, width = 'md', describedBy }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEscape(onClose, open);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const firstFocusable = dialog?.querySelector<HTMLElement>(FOCUSABLE);
    firstFocusable?.focus();
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // モーダル外へ Tab / Shift+Tab で抜けないよう、フォーカスを内部で循環させる。
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' || dialog === null || dialog === undefined) return;
      const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (item) => item.offsetParent !== null || item === document.activeElement,
      );
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0] as HTMLElement;
      const last = items[items.length - 1] as HTMLElement;
      const active = document.activeElement;
      const index = active instanceof HTMLElement ? items.indexOf(active) : -1;
      if (event.shiftKey) {
        if (index <= 0) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (index === -1 || index === items.length - 1) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = originalOverflow;
      previous?.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6"
      role="presentation"
    >
      <div
        className="fade-in absolute inset-0"
        style={{ background: 'color-mix(in srgb, #16181a 55%, transparent)' }}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={`rise-in card relative w-full ${WIDTH_CLASS[width]} max-h-[92dvh] overflow-y-auto overscroll-contain rounded-b-none sm:rounded-b-[12px]`}
        style={{ boxShadow: 'var(--shadow-float)' }}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3">
          <h2 className="text-[1.05rem]">{title}</h2>
          <button type="button" className="btn btn-ghost -mr-1 -mt-1" onClick={onClose} aria-label="閉じる">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none">
              <path d="M3.5 3.5l9 9m0-9l-9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <hr className="rule" />
        <div className="px-5 py-4">{children}</div>
        {footer !== undefined && (
          <>
            <hr className="rule" />
            <div className="flex flex-wrap items-center justify-end gap-2 px-5 py-3">{footer}</div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

import { useToastStore, type ToastTone } from '../lib/hooks';

const TONE_STYLE: Record<ToastTone, { border: string; icon: string }> = {
  info: { border: 'var(--border-strong)', icon: '·' },
  success: { border: 'var(--accent)', icon: '✓' },
  warning: { border: 'var(--clay)', icon: '!' },
  error: { border: 'var(--danger)', icon: '×' },
};

export function Toaster() {
  const toasts = useToastStore((state) => state.toasts);
  const dismiss = useToastStore((state) => state.dismiss);

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      role="status"
      aria-live="polite"
    >
      {toasts.map((toast) => {
        const tone = TONE_STYLE[toast.tone];
        return (
          <button
            key={toast.id}
            type="button"
            onClick={() => dismiss(toast.id)}
            className="rise-in card pointer-events-auto flex max-w-md items-center gap-2.5 px-3.5 py-2 text-left text-[0.86rem]"
            style={{ borderLeft: `3px solid ${tone.border}` }}
          >
            <span aria-hidden="true" className="code-text text-[0.9rem]" style={{ color: tone.border }}>
              {tone.icon}
            </span>
            <span>{toast.message}</span>
          </button>
        );
      })}
    </div>
  );
}

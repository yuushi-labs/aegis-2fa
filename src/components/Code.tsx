import { formatCode } from '../lib/format';

export type RingProps = {
  /** 0..1 */
  progress: number;
  size?: number;
  stroke?: number;
  label?: string;
};

/** 残り時間のリング。装飾なので aria-hidden。 */
export function ProgressRing({ progress, size = 26, stroke = 2.5, label }: RingProps) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(1, progress));
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      className="shrink-0"
      data-label={label}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--ring-track)"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - clamped)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 300ms linear' }}
      />
    </svg>
  );
}

export type CodeProps = {
  code: string;
  /** 3+3 / 4+4 区切りをやめる */
  compact?: boolean;
  size?: 'sm' | 'md' | 'lg';
};

// スマホ幅（360〜390px）でも行からはみ出さないよう、小さい画面では一段小さくする。
const SIZES: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'text-[1.02rem] sm:text-[1.05rem]',
  md: 'text-[1.28rem] sm:text-[1.45rem]',
  lg: 'text-[1.9rem] sm:text-[2.6rem]',
};

export function Code({ code, compact = false, size = 'md' }: CodeProps) {
  const text = compact ? code : formatCode(code);
  return (
    <span
      className={`code-text ${SIZES[size]} leading-none`}
      style={{ fontVariantNumeric: 'tabular-nums' }}
      data-testid="otp-code"
    >
      {text}
    </span>
  );
}

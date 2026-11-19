import { avatarTone, initials } from '../lib/format';

export function Avatar({ issuer, label, size = 38 }: { issuer: string; label: string; size?: number }) {
  const tone = avatarTone(issuer, label);
  return (
    <span
      className="avatar"
      style={{ background: tone.background, color: tone.color, width: size, height: size, fontSize: size * 0.36 }}
      aria-hidden="true"
    >
      {initials(issuer, label)}
    </span>
  );
}

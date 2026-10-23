import { useEffect, useState } from 'react';

interface Toast {
  text: string;
  action?: { label: string; href: string };
}

const EVENT = 'lanesignal:toast';

/** Shows a short message at the bottom of the screen, e.g. after sending a decision. */
export function toast(t: Toast) {
  window.dispatchEvent(new CustomEvent<Toast>(EVENT, { detail: t }));
}

/** Renders the latest toast for a few seconds. Mount once. */
export function Toaster() {
  const [current, setCurrent] = useState<(Toast & { id: number }) | null>(null);
  useEffect(() => {
    const show = (e: Event) => setCurrent({ ...(e as CustomEvent<Toast>).detail, id: Date.now() });
    window.addEventListener(EVENT, show);
    return () => window.removeEventListener(EVENT, show);
  }, []);
  useEffect(() => {
    if (!current) return;
    const t = setTimeout(() => setCurrent(null), 6000);
    return () => clearTimeout(t);
  }, [current]);
  if (!current) return null;
  return (
    <div className="toast" role="status" key={current.id}>
      <span>{current.text}</span>
      {current.action && (
        <a href={current.action.href} onClick={() => setCurrent(null)}>
          {current.action.label}
        </a>
      )}
    </div>
  );
}

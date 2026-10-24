import { Component, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { AttachmentMeta, Client } from './api.ts';
import { MarkdownView } from './markdown-view.tsx';
import { pushOverlay } from './nav.ts';

/** Markdown bigger than this is shown as plain text: rendering it would be slow on a phone. */
const RENDER_LIMIT = 300_000;

const isImage = (f: AttachmentMeta) => f.type.startsWith('image/');

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The file as an object URL (or its text), fetched with the session's token; revoked on unmount. */
function useFile(client: Client, file: AttachmentMeta | null, as: 'url' | 'text') {
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // By id: live updates bring new objects for the same file, which mustn't download it again.
  const id = file?.id;
  useEffect(() => {
    if (!id) return;
    let url: string | null = null;
    let cancelled = false;
    setValue(null);
    setError(null);
    client
      .attachment(id)
      .then(async (blob) => {
        if (cancelled) return;
        if (as === 'text') setValue(await blob.text());
        else setValue((url = URL.createObjectURL(blob)));
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [client, id, as]);
  return { value, error };
}

function Thumb({ client, file }: { client: Client; file: AttachmentMeta }) {
  const { value } = useFile(client, file, 'url');
  return value ? <img src={value} alt="" /> : <span className="thumb-placeholder" />;
}

/** Files on an escalation: image thumbnails and document chips; a tap opens the viewer. */
export function AttachmentList({ client, files }: { client: Client; files: AttachmentMeta[] }) {
  const [open, setOpen] = useState<AttachmentMeta | null>(null);
  return (
    <>
      <ul className="attachments">
        {files.map((f) => (
          <li key={f.id}>
            <button className={isImage(f) ? 'attachment image' : 'attachment doc'} onClick={() => setOpen(f)}>
              {isImage(f) ? <Thumb client={client} file={f} /> : <span className="doc-icon">{f.type === 'text/markdown' ? 'MD' : 'TXT'}</span>}
              <span className="attachment-name">{f.name}</span>
              <span className="muted">{size(f.size)}</span>
            </button>
          </li>
        ))}
      </ul>
      {open && <AttachmentViewer client={client} file={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/** Full-screen view of one file: rendered Markdown, plain text, or an image you can zoom. */
function AttachmentViewer({ client, file, onClose }: { client: Client; file: AttachmentMeta; onClose: () => void }) {
  const image = isImage(file);
  const { value, error } = useFile(client, file, image ? 'url' : 'text');

  // Android's back button closes the viewer first.
  useEffect(() => pushOverlay(onClose), [onClose]);

  // Escape closes the viewer, not the escalation under it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className={`viewer${image ? ' viewer-image' : ''}`} role="dialog" aria-label={file.name} onClick={(e) => e.stopPropagation()}>
      <header className="viewer-head">
        <button className="back" onClick={onClose} aria-label="Close the attachment">
          ← Escalation
        </button>
        <span className="viewer-name">{file.name}</span>
      </header>
      {error && <p className="error viewer-body">{error}</p>}
      {!value && !error && <p className="muted viewer-body">Loading…</p>}
      {value &&
        (image ? (
          <ZoomImage src={value} alt={file.name} />
        ) : file.type === 'text/markdown' && value.length <= RENDER_LIMIT ? (
          <div className="viewer-body">
            <Fallback text={value}>
              <MarkdownView text={value} />
            </Fallback>
          </div>
        ) : (
          <pre className="viewer-body plain-text">{value}</pre>
        ))}
    </div>
  );
}

/** Shows the file as plain text if rendering it fails, rather than blanking the app. */
class Fallback extends Component<{ text: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <pre className="plain-text">{this.props.text}</pre> : this.props.children;
  }
}

/** An image that pinches, drags and double-taps to zoom (mouse wheel on desktop). */
function ZoomImage({ src, alt }: { src: string; alt: string }) {
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; scale: number } | null>(null);
  const lastTap = useRef(0);

  const clamp = (scale: number) => Math.min(6, Math.max(1, scale));
  const distance = () => {
    const [a, b] = [...pointers.current.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  function down(e: ReactPointerEvent) {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) pinch.current = { distance: distance(), scale: view.scale };
    else if (pointers.current.size === 1) {
      const now = Date.now();
      if (now - lastTap.current < 300) setView((v) => (v.scale > 1 ? { scale: 1, x: 0, y: 0 } : { ...v, scale: 2.5 }));
      lastTap.current = now;
    }
  }

  function move(e: ReactPointerEvent) {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && pinch.current) {
      const p = pinch.current;
      setView((v) => ({ ...v, scale: clamp((p.scale * distance()) / p.distance) }));
    } else if (pointers.current.size === 1) {
      setView((v) => (v.scale > 1 ? { ...v, x: v.x + e.clientX - prev.x, y: v.y + e.clientY - prev.y } : v));
    }
  }

  function up(e: ReactPointerEvent) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    setView((v) => (v.scale <= 1 ? { scale: 1, x: 0, y: 0 } : v));
  }

  return (
    <div
      className="zoom"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onWheel={(e) => setView((v) => {
        const scale = clamp(v.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
        return scale <= 1 ? { scale: 1, x: 0, y: 0 } : { ...v, scale };
      })}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
      />
    </div>
  );
}

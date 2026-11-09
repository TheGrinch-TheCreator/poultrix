// Smooth live camera player shared by the main app and the maintenance site.
// It has no app-login imports, so the maintenance site can use it with its
// own maintenance token (`openStream`).
import { useEffect, useRef, useState, type ReactNode } from "react";

export const RETRY_MS = 3000;
const MAX_VIDEO_FAILURES = 3; // then use the picture stream for this visit
const LIVE_EDGE_MAX_S = 2.5; // jump forward when playback lags this much
const KEEP_BUFFER_S = 10;

type MediaSourceCtor = typeof MediaSource;

function mediaSourceClass(): MediaSourceCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    ManagedMediaSource?: MediaSourceCtor;
    MediaSource?: MediaSourceCtor;
  };
  return w.ManagedMediaSource ?? w.MediaSource ?? null;
}

/** Codec string from the avcC box in the MP4 init segment, e.g. avc1.42c01e. */
function codecFromInit(init: Uint8Array): string | null {
  for (let i = 4; i + 7 < init.length; i++) {
    if (init[i] === 0x61 && init[i + 1] === 0x76 && init[i + 2] === 0x63 && init[i + 3] === 0x43) {
      const hex = (n: number | undefined) => (n ?? 0).toString(16).padStart(2, "0");
      return `avc1.${hex(init[i + 5])}${hex(init[i + 6])}${hex(init[i + 7])}`;
    }
  }
  return null;
}

/** Length of the init segment (ftyp + moov) at the start of `data`, or 0 if
 *  it hasn't fully arrived yet. */
function initLength(data: Uint8Array): number {
  let offset = 0;
  while (offset + 8 <= data.length) {
    const size = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0);
    const type = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
    if (size < 8 || offset + size > data.length) return 0;
    offset += size;
    if (type === "moov") return offset;
  }
  return 0;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/**
 * Smooth live camera view: H.264 in fragmented MP4 from the Pi
 * (`/camera/live`, one long request), played with Media Source Extensions.
 * It stays near the live edge, stops while the tab is hidden, and reconnects
 * by itself. Browsers without MSE (or repeated failures) get `fallback`
 * (the older picture stream).
 */
export function LiveVideoPlayer({
  enabled,
  alt,
  className,
  openStream,
  fallback,
}: {
  enabled: boolean;
  alt: string;
  className?: string | undefined;
  /** Opens the `/api/pi/camera/live` request with the right credentials. */
  openStream: (signal: AbortSignal) => Promise<Response>;
  fallback: ReactNode;
}) {
  const openRef = useRef(openStream);
  openRef.current = openStream;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [mode, setMode] = useState<"video" | "pictures">(() =>
    mediaSourceClass() ? "video" : "pictures",
  );
  const [status, setStatus] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    const MS = mediaSourceClass();
    const video = videoRef.current;
    if (mode !== "video" || !enabled || !visible || !MS || !video) return;
    let stopped = false;
    let failures = 0;
    let controller: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let objectUrl: string | null = null;

    const cleanupMedia = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null;
      video.removeAttribute("src");
      video.load();
    };

    const connect = async () => {
      controller = new AbortController();
      setStatus(failures ? "reconnecting" : "connecting");
      let gotVideo = false;
      try {
        const response = await openRef.current(controller.signal);
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        const reader = response.body.getReader();
        let pending: Uint8Array = new Uint8Array(0);
        let init: Uint8Array | null = null;
        // Read until the init segment (ftyp + moov) is complete.
        while (!init) {
          const { done, value } = await reader.read();
          if (done || stopped) throw new Error("stream ended");
          pending = concat(pending, value);
          const length = initLength(pending);
          if (length) {
            init = pending.slice(0, length);
            pending = pending.slice(length);
          }
        }
        const codec = codecFromInit(init);
        const mime = `video/mp4; codecs="${codec ?? "avc1.42c01e"}"`;
        if (!MS.isTypeSupported(mime)) {
          setMode("pictures");
          return;
        }
        const source = new MS();
        objectUrl = URL.createObjectURL(source);
        (video as HTMLVideoElement & { disableRemotePlayback: boolean }).disableRemotePlayback =
          true;
        video.src = objectUrl;
        await new Promise<void>((resolve) =>
          source.addEventListener("sourceopen", () => resolve(), { once: true }),
        );
        const buffer = source.addSourceBuffer(mime);
        buffer.mode = "sequence"; // fragments the Pi skipped just join up
        const queue: Uint8Array[] = [init, pending];
        const pump = () => {
          if (buffer.updating || !queue.length || source.readyState !== "open") return;
          const next = queue.shift()!;
          if (next.length) buffer.appendBuffer(next as BufferSource);
          else pump();
        };
        buffer.addEventListener("updateend", () => {
          const ranges = video.buffered;
          if (ranges.length) {
            const end = ranges.end(ranges.length - 1);
            const start = ranges.start(0);
            // Stay close to live: skip ahead instead of drifting behind.
            if (end - video.currentTime > LIVE_EDGE_MAX_S)
              video.currentTime = Math.max(start, end - 0.3);
            // Drop old video so memory doesn't grow.
            if (!buffer.updating && video.currentTime - start > KEEP_BUFFER_S * 2) {
              buffer.remove(start, video.currentTime - KEEP_BUFFER_S);
              return;
            }
          }
          pump();
        });
        pump();
        void video.play().catch(() => undefined);
        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!gotVideo) {
            gotVideo = true;
            failures = 0;
            setStatus("live");
          }
          queue.push(value);
          pump();
        }
      } catch {
        // falls through to reconnect
      }
      if (stopped) return;
      cleanupMedia();
      failures = gotVideo ? 1 : failures + 1;
      if (!gotVideo && failures >= MAX_VIDEO_FAILURES) {
        setMode("pictures");
        return;
      }
      setStatus("reconnecting");
      retryTimer = setTimeout(() => void connect(), RETRY_MS);
    };

    void connect();
    return () => {
      stopped = true;
      controller?.abort();
      if (retryTimer) clearTimeout(retryTimer);
      cleanupMedia();
    };
  }, [mode, enabled, visible]);

  if (mode === "pictures") return <>{fallback}</>;
  return (
    <div className="relative h-full w-full">
      <video ref={videoRef} muted autoPlay playsInline aria-label={alt} className={className} />
      {status !== "live" && (
        <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-white">
          {!enabled
            ? "Camera offline"
            : status === "reconnecting"
              ? "Stream interrupted, reconnecting…"
              : "Connecting…"}
        </p>
      )}
    </div>
  );
}

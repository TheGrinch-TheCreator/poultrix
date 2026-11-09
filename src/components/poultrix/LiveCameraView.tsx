import { useEffect, useState } from "react";
import { LiveVideoPlayer, RETRY_MS } from "@/components/poultrix/LiveVideoPlayer";
import { authorizedFetch, PI_BASE } from "@/lib/pi-client";
import { useCameraStreamUrl } from "@/lib/live-endpoints";

/** Main app live camera: smooth H.264 video with the signed-in user's token,
 *  falling back to the picture stream (see LiveVideoPlayer). */
export function LiveCameraView({
  enabled,
  alt,
  className,
}: {
  enabled: boolean;
  alt: string;
  className?: string | undefined;
}) {
  return (
    <LiveVideoPlayer
      enabled={enabled}
      alt={alt}
      className={className}
      openStream={(signal) => authorizedFetch(`${PI_BASE}/camera/live`, { signal })}
      fallback={<PictureStream enabled={enabled} alt={alt} className={className} />}
    />
  );
}

/** Older picture stream (MJPEG): browsers without Media Source Extensions. */
function PictureStream({
  enabled,
  alt,
  className,
}: {
  enabled: boolean;
  alt: string;
  className?: string | undefined;
}) {
  const streamUrl = useCameraStreamUrl(enabled);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!failed) return;
    const timer = setTimeout(() => {
      setFailed(false);
      setAttempt((n) => n + 1);
    }, RETRY_MS);
    return () => clearTimeout(timer);
  }, [failed]);
  if (!enabled || !streamUrl || failed)
    return (
      <p className="flex h-full w-full items-center justify-center p-4 text-center text-sm text-white">
        {!enabled ? "Camera offline" : failed ? "Stream interrupted, reconnecting…" : "Connecting…"}
      </p>
    );
  return (
    <img
      key={attempt}
      src={streamUrl}
      alt={alt}
      className={className}
      onError={() => setFailed(true)}
    />
  );
}

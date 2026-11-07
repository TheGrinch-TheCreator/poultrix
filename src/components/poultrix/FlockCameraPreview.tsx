import { useEffect, useState } from "react";
import { useCameraStreamUrl } from "@/lib/live-endpoints";

const RETRY_MS = 5000;

/** Flock preview: the same authenticated MJPEG stream as the AI Stage page,
 *  through the Worker gateway, so it works on mobile data too. Shows
 *  automatically when the camera is online, stops while the tab is hidden,
 *  and reconnects by itself if the stream drops. */
export function FlockCameraPreview({ cameraReady }: { cameraReady: boolean }) {
  const streamUrl = useCameraStreamUrl(cameraReady);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!failed) return;
    const timer = setTimeout(() => { setFailed(false); setAttempt((n) => n + 1); }, RETRY_MS);
    return () => clearTimeout(timer);
  }, [failed]);

  const showStream = cameraReady && !!streamUrl && !failed;
  const status = !cameraReady ? "Camera offline" : failed ? "Stream interrupted, reconnecting…" : "Connecting…";

  return (
    <div className="relative flex h-full w-full items-center justify-center bg-black">
      {showStream ? (
        <img
          key={attempt}
          src={streamUrl}
          alt="Live flock camera"
          className="h-full w-full object-contain"
          onError={() => setFailed(true)}
        />
      ) : (
        <p className="p-4 text-center text-sm text-white">{status}</p>
      )}
    </div>
  );
}

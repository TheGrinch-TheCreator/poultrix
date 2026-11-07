import { useState } from "react";
import { useCameraStreamUrl } from "@/lib/live-endpoints";

/** Flock preview: the same authenticated MJPEG stream as the AI Stage page,
 *  through the Worker gateway, so it works on mobile data too. Starts on
 *  demand and stops while the tab is hidden (bandwidth + request budget). */
export function FlockCameraPreview({ cameraReady }: { cameraReady: boolean }) {
  const [watching, setWatching] = useState(false);
  const [failed, setFailed] = useState(false);
  const streamUrl = useCameraStreamUrl(watching && cameraReady);

  const start = () => { setFailed(false); setWatching(true); };
  const stop = () => setWatching(false);

  const showStream = watching && cameraReady && !!streamUrl && !failed;
  const status = !cameraReady ? "Camera offline" : failed ? "Stream interrupted" : watching ? "Connecting…" : "Ready to connect";

  return (
    <div className="relative flex h-full w-full items-center justify-center bg-black">
      {showStream && (
        <img
          src={streamUrl}
          alt="Live flock camera"
          className="h-full w-full object-contain"
          onError={() => setFailed(true)}
        />
      )}
      {!showStream && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/75 p-4 text-center text-white">
          <p className="text-sm">{status}</p>
          {cameraReady && (
            <button type="button" onClick={start} className="rounded-md bg-white px-4 py-2 text-sm font-semibold text-[#010736]">
              {failed ? "Retry live preview" : "Start live preview"}
            </button>
          )}
        </div>
      )}
      {showStream && (
        <div className="absolute bottom-2 right-2 flex items-center gap-2 rounded-md bg-black/70 px-2 py-1 text-xs text-white">
          <span>Live</span>
          <button type="button" onClick={stop} className="underline">Stop</button>
        </div>
      )}
    </div>
  );
}

import { LiveCameraView } from "@/components/poultrix/LiveCameraView";

/** Flock preview: the same smooth live video as the AI Stage page, through
 *  the Worker gateway, so it works on mobile data too. Shows automatically
 *  when the camera is online, stops while the tab is hidden, and reconnects
 *  by itself. Falls back to the picture stream on browsers without MSE. */
export function FlockCameraPreview({ cameraReady }: { cameraReady: boolean }) {
  return (
    <div className="relative flex h-full w-full items-center justify-center bg-black">
      <LiveCameraView
        enabled={cameraReady}
        alt="Live flock camera"
        className="h-full w-full object-contain"
      />
    </div>
  );
}

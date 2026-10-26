import { useEffect, useRef, useState } from "react";

const SIGNALING_URL = "http://127.0.0.1:8088/offer";

export function FlockWebRTCPreview() {
  const video = useRef<HTMLVideoElement>(null);
  const peer = useRef<RTCPeerConnection | null>(null);
  const [status, setStatus] = useState("Ready to connect");
  const [playing, setPlaying] = useState(false);

  function stop() {
    peer.current?.close();
    peer.current = null;
    if (video.current) video.current.srcObject = null;
    setPlaying(false);
    setStatus("Stopped");
  }

  useEffect(() => () => {
    peer.current?.close();
    peer.current = null;
  }, []);

  async function start() {
    stop();
    const pc = new RTCPeerConnection({ iceServers: [] });
    peer.current = pc;
    setStatus("Connecting…");
    try {
      pc.ontrack = (event) => {
        if (video.current) {
          video.current.srcObject = event.streams[0] || new MediaStream([event.track]);
          void video.current.play().catch(() => {});
        }
        setPlaying(true);
      };
      pc.onconnectionstatechange = () => {
        if (peer.current !== pc) return;
        setStatus(`Connection: ${pc.connectionState}`);
        if (pc.connectionState === "failed") setPlaying(false);
      };
      pc.addTransceiver("video", { direction: "recvonly" });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await new Promise<void>((resolve, reject) => {
        if (pc.iceGatheringState === "complete") return resolve();
        const timer = setTimeout(() => reject(new Error("ICE gathering timed out")), 10000);
        pc.addEventListener("icegatheringstatechange", () => {
          if (pc.iceGatheringState === "complete") { clearTimeout(timer); resolve(); }
        });
      });
      const response = await fetch(SIGNALING_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "offer", sdp: pc.localDescription?.sdp }),
      });
      if (!response.ok) throw new Error(`Signaling HTTP ${response.status}`);
      const answer = await response.json();
      if (peer.current !== pc) return;
      await pc.setRemoteDescription(answer);
    } catch (error) {
      setStatus(`Connection error: ${error instanceof Error ? error.message : String(error)}`);
      if (peer.current === pc) { pc.close(); peer.current = null; }
    }
  }

  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center bg-black">
      <video ref={video} autoPlay muted playsInline className="h-full w-full object-contain" />
      {!playing && <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/75 p-4 text-center text-white">
        <p className="text-sm">{status}</p>
        <button type="button" onClick={() => void start()} className="rounded-md bg-white px-4 py-2 text-sm font-semibold text-[#010736]">Start live preview</button>
        <p className="max-w-sm text-xs text-white/70">Local test: requires the SSH tunnel on this computer. Not yet available over mobile data.</p>
      </div>}
      {playing && <div className="absolute bottom-2 right-2 flex items-center gap-2 rounded-md bg-black/70 px-2 py-1 text-xs text-white">
        <span>{status}</span>
        <button type="button" onClick={stop} className="underline">Stop</button>
      </div>}
    </div>
  );
}

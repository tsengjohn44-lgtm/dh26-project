"use client";

import { useEffect, useRef, useState } from "react";

const INTERVAL_MS = 3000;
const MAX_WIDTH = 640;
const JPEG_QUALITY = 0.7;
const SIMILARITY_SKIP = 0.8;

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .split(/\s+/)
      .filter(Boolean),
  );
}

// Jaccard similarity of the two texts' word sets (1 = same words).
function similarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 && wb.size === 0) return 1;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const id = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(id);
      resolve();
    });
  });
}

// A few silent WAV samples, played inside the Start tap so iOS allows later playback.
function silentWavUrl(): string {
  const samples = 800;
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples * 2, true);
  str(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true);
  v.setUint32(28, 16000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

function captureFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement): Promise<string | null> {
  const { videoWidth: w, videoHeight: h } = video;
  if (!w || !h) return Promise.resolve(null);
  const scale = Math.min(1, MAX_WIDTH / w);
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) return resolve(null);
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      },
      "image/jpeg",
      JPEG_QUALITY,
    );
  });
}

function playUntilEnd(audio: HTMLAudioElement, src: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      audio.removeEventListener("ended", done);
      audio.removeEventListener("error", done);
      resolve();
    };
    audio.addEventListener("ended", done);
    audio.addEventListener("error", done);
    signal.addEventListener("abort", () => {
      audio.pause();
      done();
    });
    audio.src = src;
    audio.play().catch(done);
  });
}

// Fallback voice for errors, so they're heard even if the TTS API is what failed.
function announce(text: string) {
  if (typeof speechSynthesis === "undefined") return;
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

export default function Home() {
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("Tap Start. Point your phone ahead.");
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setRunning(false);
  }

  useEffect(() => stop, []);

  async function loop(signal: AbortSignal) {
    const video = videoRef.current!;
    const canvas = (canvasRef.current ??= document.createElement("canvas"));
    const audio = audioRef.current!;
    let lastSpoken = "";
    let lastError = "";

    while (!signal.aborted) {
      try {
        const image = await captureFrame(video, canvas);
        if (image) {
          const res = await fetch("/api/describe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image }),
            signal,
          });
          if (!res.ok) throw new Error("Could not describe the scene.");
          const { text } = (await res.json()) as { text: string };

          if (text && similarity(text, lastSpoken) < SIMILARITY_SKIP) {
            setStatus(text);
            const speech = await fetch("/api/speak", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text }),
              signal,
            });
            if (!speech.ok) throw new Error("Could not play speech.");
            const url = URL.createObjectURL(await speech.blob());
            lastSpoken = text;
            await playUntilEnd(audio, url, signal);
            URL.revokeObjectURL(url);
          }
          lastError = "";
        }
      } catch (err) {
        if (signal.aborted) break;
        const message = err instanceof Error ? err.message : "Something went wrong.";
        setStatus(message);
        if (message !== lastError) announce(message);
        lastError = message;
      }
      await sleep(INTERVAL_MS, signal);
    }
  }

  async function start() {
    // Unlock audio playback while still inside the tap gesture.
    const audio = (audioRef.current ??= new Audio());
    audio.src = silentWavUrl();
    audio.play().catch(() => {});

    setStatus("Starting camera…");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
    } catch {
      const message = "Camera unavailable. Allow camera access and try again.";
      setStatus(message);
      announce(message);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setStatus("Looking…");
    loop(controller.signal);
  }

  return (
    <main>
      <button
        type="button"
        className="toggle"
        aria-pressed={running}
        onClick={running ? stop : start}
      >
        {running ? "Stop" : "Start"}
      </button>
      <p className="status" aria-live="polite">
        {status}
      </p>
      <video ref={videoRef} playsInline muted />
    </main>
  );
}

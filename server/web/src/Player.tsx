import { useEffect, useRef } from 'react';
import Hls from 'hls.js';

/** Minimal HLS preview player used in the admin UI. */
export function Player({ src }: { src: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (src.includes('.m3u8') && Hls.isSupported()) {
      const hls = new Hls({ liveDurationInfinity: true });
      hls.loadSource(src);
      hls.attachMedia(video);
      return () => hls.destroy();
    }
    video.src = src;
    return () => {
      video.removeAttribute('src');
      video.load();
    };
  }, [src]);

  return <video ref={videoRef} controls autoPlay muted playsInline />;
}

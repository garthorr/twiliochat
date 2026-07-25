import type { RealtimeEvent } from "./api";

/**
 * Connect to /ws with automatic exponential-backoff reconnect.
 * onOpen also fires on every reconnect so callers can refetch missed state.
 * Returns a cleanup function.
 */
export function connectRealtime(
  onEvent: (event: RealtimeEvent) => void,
  onOpen: () => void,
): () => void {
  let socket: WebSocket | null = null;
  let stopped = false;
  let delay = 1000;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${proto}://${location.host}/ws`);
    socket.onopen = () => {
      delay = 1000;
      onOpen();
    };
    socket.onmessage = (e) => {
      try {
        onEvent(JSON.parse(e.data as string) as RealtimeEvent);
      } catch {
        // ignore malformed frames
      }
    };
    socket.onclose = () => {
      if (stopped) return;
      timer = setTimeout(open, delay);
      delay = Math.min(delay * 2, 15_000);
    };
  };

  open();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    socket?.close();
  };
}

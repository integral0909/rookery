// A WebSocket that reconnects with backoff and re-sends its watch list.
// Listeners get every server event; 'open' and 'close' report the link.
export class Socket {
  constructor(url) {
    this.url = url;
    this.listeners = new Set();
    this.watching = new Set();
    this.attempt = 0;
    this.stopped = false;
    this.ws = null;
    this.connected = false;
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start() {
    this.stopped = false;
    this.#connect();
    document.addEventListener('visibilitychange', () => {
      // Phones freeze background tabs; reconnect promptly on return.
      if (document.visibilityState === 'visible' && !this.connected && !this.stopped) this.#connect();
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.ws?.close();
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  watch(channelId) {
    this.watching.add(channelId);
    this.send({ type: 'watch', channelId });
  }

  unwatch(channelId) {
    this.watching.delete(channelId);
    this.send({ type: 'unwatch', channelId });
  }

  #emit(event) {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch (err) {
        console.error('socket listener failed', err);
      }
    }
  }

  #connect() {
    clearTimeout(this.retry);
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.connected = true;
      for (const id of this.watching) this.send({ type: 'watch', channelId: id });
      this.#emit({ type: 'open' });
    };
    ws.onmessage = (e) => {
      let event;
      try {
        event = JSON.parse(e.data);
      } catch {
        return;
      }
      this.#emit(event);
    };
    ws.onclose = (e) => {
      const was = this.connected;
      this.connected = false;
      if (this.ws === ws) this.ws = null;
      if (was) this.#emit({ type: 'close', code: e.code });
      if (this.stopped || e.code === 4001) return;
      const delay = Math.min(30_000, 500 * 2 ** this.attempt) * (0.75 + Math.random() * 0.5);
      this.attempt++;
      this.retry = setTimeout(() => this.#connect(), delay);
    };
  }
}

import type { ClientMessage, ServerMessage } from '../shared';

export type ConnStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface PokerClientOptions {
  url: string;
  onStatus?: (s: ConnStatus) => void;
  onMessage: (msg: ServerMessage) => void;
  onClose?: () => void;
}

/**
 * 仅负责传输层：连接、自动重连、心跳。所有业务语义（action / state / 重连补齐）
 * 都由服务端权威裁决，客户端只转发意图并消费视图。
 *
 * 安全红线：
 *  - 客户端绝不缓存/日志 holeCards（除本人当前手牌由服务端在 view 中下发）；
 *  - 断线重连携带 lastSeq，由服务端 rebuild 后恢复，客户端不本地推导状态。
 */
export class PokerClient {
  private ws: WebSocket | null = null;
  private lastSeq = 0;
  private closedByUser = false;
  private backoffMs = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly urlBase: string;

  constructor(private readonly opts: PokerClientOptions) {
    this.urlBase = opts.url;
  }

  connect(lastSeq = 0): void {
    this.lastSeq = lastSeq;
    this.closedByUser = false;
    this.open();
  }

  private open(): void {
    if (typeof WebSocket === 'undefined') return;
    const sep = this.urlBase.includes('?') ? '&' : '?';
    const url = `${this.urlBase}${sep}lastSeq=${this.lastSeq}`;
    this.opts.onStatus?.(this.ws ? 'reconnecting' : 'connecting');

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.backoffMs = 500;
      this.opts.onStatus?.('open');
    };

    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data as string) as ServerMessage;
      } catch {
        return; // 丢弃无法解析的帧
      }
      if (msg.t === 'state') this.lastSeq = msg.seq;
      this.opts.onMessage(msg);
    };

    ws.onclose = () => {
      if (this.closedByUser) {
        this.opts.onStatus?.('closed');
        this.opts.onClose?.();
        return;
      }
      this.opts.onStatus?.('reconnecting');
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // 错误由 onclose 兜底处理，这里不主动关闭以免重复触发
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.open(), this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, 8000);
  }

  /** 仅发送意图类型，金额范围严格来自服务端 legal 白名单（见 store.sendAction） */
  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
  }
}

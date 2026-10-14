import {
  AlertItem,
  WsConnectionStatus,
  WsDeviceStatusPayload,
  WsTelemetryPayload,
} from '../types/api';
import { TokenStore } from './tokenStore';
import { normalizeBaseUrl } from '../config/env';

export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string; wasClean?: boolean }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string, protocols: string[]) => WebSocketLike;

export interface WsClientCallbacks {
  onStatusChange?: (status: WsConnectionStatus, info: WsStatusMetadata) => void;
  onTelemetry?: (payload: WsTelemetryPayload) => void;
  onAlert?: (alert: AlertItem) => void;
  onDeviceStatus?: (status: WsDeviceStatusPayload) => void;
}

export interface WsStatusMetadata {
  reconnectAttempt: number;
  nextRetryDelayMs: number | null;
  lastPingSentAt: string | null;
  lastMessageReceivedAt: string | null;
  disconnectReason: string | null;
}

export interface WsClientOptions {
  wsBaseUrl: string;
  tokenStore: TokenStore;
  pingIntervalMs?: number;
  baseReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  wsFactory?: WebSocketFactory;
  callbacks?: WsClientCallbacks;
}

const WS_OPEN_STATE = 1;

/**
 * Quản lý kết nối WebSocket Realtime:
 * - Authentication: `bearer` WebSocket subprotocol; token is not placed in the URL.
 * - Định kỳ gửi text "ping" để duy trì receive loop phía FastAPI backend.
 * - Khi mất kết nối ngoài ý muốn, tự động reconnect theo cơ chế exponential backoff.
 * - Khi người dùng logout hoặc gọi disconnect(), hủy toàn bộ timer và đóng socket sạch sẽ.
 * - Tuyệt đối không log URL chứa token hoặc nội dung nhạy cảm ra console/UI.
 */
export class TelemetryWebSocketClient {
  private wsBaseUrl: string;
  private readonly tokenStore: TokenStore;
  private readonly pingIntervalMs: number;
  private readonly baseReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly wsFactory: WebSocketFactory;
  private callbacks: WsClientCallbacks;

  private socket: WebSocketLike | null = null;
  private status: WsConnectionStatus = 'disconnected';
  private intentionalClose = false;
  private reconnectAttempt = 0;
  private nextRetryDelayMs: number | null = null;
  private lastPingSentAt: string | null = null;
  private lastMessageReceivedAt: string | null = null;
  private disconnectReason: string | null = null;

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: WsClientOptions) {
    this.wsBaseUrl = normalizeBaseUrl(options.wsBaseUrl);
    this.tokenStore = options.tokenStore;
    this.pingIntervalMs = options.pingIntervalMs ?? 25000;
    this.baseReconnectDelayMs = options.baseReconnectDelayMs ?? 1000;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 30000;
    this.callbacks = options.callbacks || {};
    this.wsFactory =
      options.wsFactory ||
      ((url: string, protocols: string[]) =>
        new WebSocket(url, protocols) as unknown as WebSocketLike);
  }

  public setWsBaseUrl(url: string): void {
    this.wsBaseUrl = normalizeBaseUrl(url);
  }

  public setCallbacks(callbacks: WsClientCallbacks): void {
    this.callbacks = callbacks;
  }

  public getStatus(): WsConnectionStatus {
    return this.status;
  }

  public getMetadata(): WsStatusMetadata {
    return {
      reconnectAttempt: this.reconnectAttempt,
      nextRetryDelayMs: this.nextRetryDelayMs,
      lastPingSentAt: this.lastPingSentAt,
      lastMessageReceivedAt: this.lastMessageReceivedAt,
      disconnectReason: this.disconnectReason,
    };
  }

  public connect(): void {
    const token = this.tokenStore.getAccessToken();
    if (!token) {
      this.disconnectReason = 'Thiếu access token để mở kết nối WebSocket.';
      this.updateStatus('auth_failed');
      return;
    }

    this.intentionalClose = false;
    this.clearReconnectTimer();
    this.closeCurrentSocketOnly();

    const nextState: WsConnectionStatus =
      this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting';
    this.updateStatus(nextState);

    const wsUrl = `${this.wsBaseUrl}/ws/telemetry`;

    let ws: WebSocketLike;
    try {
      ws = this.wsFactory(wsUrl, ['bearer', token]);
    } catch {
      this.disconnectReason = 'Không thể khởi tạo kết nối WebSocket.';
      this.scheduleReconnect();
      return;
    }

    this.socket = ws;

    ws.onopen = () => {
      if (this.socket !== ws) return;
      this.reconnectAttempt = 0;
      this.nextRetryDelayMs = null;
      this.disconnectReason = null;
      this.updateStatus('connected');
      this.startPingHeartbeat();
      // Gửi gói "ping" đầu tiên ngay khi mở kết nối để kích hoạt receive loop phía backend
      this.sendPing();
    };

    ws.onmessage = (event: { data: string }) => {
      if (this.socket !== ws) return;
      this.lastMessageReceivedAt = new Date().toISOString();
      this.handleIncomingMessage(event.data);
    };

    ws.onerror = () => {
      if (this.socket !== ws) return;
      this.disconnectReason = 'Kết nối WebSocket gặp sự cố mạng hoặc máy chủ từ chối.';
    };

    ws.onclose = (closeEvent) => {
      if (this.socket !== ws) return;
      this.stopPingHeartbeat();
      this.socket = null;

      if (this.intentionalClose) {
        this.reconnectAttempt = 0;
        this.nextRetryDelayMs = null;
        this.disconnectReason = null;
        this.updateStatus('disconnected');
        return;
      }

      if (closeEvent && (closeEvent.code === 1008 || closeEvent.code === 4001 || closeEvent.code === 4003)) {
        this.disconnectReason = 'Phiên WebSocket bị từ chối xác thực (Token hết hạn hoặc không hợp lệ).';
        this.updateStatus('auth_failed');
        return;
      }

      this.disconnectReason =
        closeEvent && closeEvent.reason
          ? `Mất kết nối realtime (${closeEvent.reason})`
          : 'Mất kết nối WebSocket với backend. Đang tự động kết nối lại...';

      this.scheduleReconnect();
    };
  }

  /**
   * Gửi chuỗi "ping" định kỳ để duy trì receive loop của FastAPI WebSocket.
   * Không bao giờ gửi thông tin nhạy cảm qua frame này.
   */
  public sendPing(): boolean {
    if (!this.socket || this.socket.readyState !== WS_OPEN_STATE) {
      return false;
    }
    try {
      this.socket.send('ping');
      this.lastPingSentAt = new Date().toISOString();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Đóng kết nối chủ động (khi logout hoặc chuyển chế độ):
   * Hủy toàn bộ timer ping/reconnect và đóng socket.
   */
  public disconnect(): void {
    this.intentionalClose = true;
    this.clearReconnectTimer();
    this.stopPingHeartbeat();
    this.closeCurrentSocketOnly();
    this.reconnectAttempt = 0;
    this.nextRetryDelayMs = null;
    this.disconnectReason = null;
    this.updateStatus('disconnected');
  }

  /**
   * Cho phép người dùng bấm "Kết nối lại ngay" mà không cần chờ hết thời gian backoff.
   */
  public retryNow(): void {
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.nextRetryDelayMs = null;
    this.connect();
  }

  public computeBackoffDelay(attempt: number): number {
    const exponential = this.baseReconnectDelayMs * Math.pow(2, Math.max(0, attempt - 1));
    return Math.min(exponential, this.maxReconnectDelayMs);
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose) return;
    if (!this.tokenStore.hasTokens()) {
      this.updateStatus('disconnected');
      return;
    }

    this.reconnectAttempt += 1;
    const delay = this.computeBackoffDelay(this.reconnectAttempt);
    this.nextRetryDelayMs = delay;
    this.updateStatus('reconnecting');

    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      if (!this.intentionalClose && this.tokenStore.hasTokens()) {
        this.connect();
      }
    }, delay);
  }

  private handleIncomingMessage(raw: string): void {
    if (!raw || raw === 'pong' || raw === 'ping') {
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== 'object') return;

    if (parsed.event === 'telemetry' && parsed.data && typeof parsed.data === 'object') {
      const data = parsed.data as WsTelemetryPayload;
      if (typeof data.device_id === 'string' && data.values && typeof data.values === 'object') {
        this.callbacks.onTelemetry?.({
          device_id: data.device_id,
          gateway_id: typeof data.gateway_id === 'string' ? data.gateway_id : 'unknown-gateway',
          timestamp: typeof data.timestamp === 'string' ? data.timestamp : new Date().toISOString(),
          values: data.values,
          actuators: data.actuators,
        });
      }
      return;
    }

    if (parsed.event === 'alert' && parsed.data && typeof parsed.data === 'object') {
      const alertData = parsed.data as AlertItem;
      this.callbacks.onAlert?.({
        ...alertData,
        message:
          typeof alertData.message === 'string'
            ? alertData.message
            : 'Cảnh báo mới từ hệ thống cảm biến',
        created_at:
          alertData.created_at || alertData.timestamp || alertData.time || new Date().toISOString(),
      });
      return;
    }

    if (parsed.event === 'device_status' && parsed.data && typeof parsed.data === 'object') {
      const data = parsed.data as Partial<WsDeviceStatusPayload>;
      if (
        typeof data.device_id === 'string' &&
        typeof data.is_online === 'boolean' &&
        (typeof data.last_seen_at === 'string' || data.last_seen_at === null)
      ) {
        this.callbacks.onDeviceStatus?.({
          device_id: data.device_id,
          is_online: data.is_online,
          last_seen_at: data.last_seen_at,
        });
      }
    }
  }

  private startPingHeartbeat(): void {
    this.stopPingHeartbeat();
    this.pingTimer = setInterval(() => {
      this.sendPing();
    }, this.pingIntervalMs);
  }

  private stopPingHeartbeat(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private closeCurrentSocketOnly(): void {
    if (this.socket) {
      const current = this.socket;
      this.socket = null;
      current.onopen = null;
      current.onmessage = null;
      current.onerror = null;
      current.onclose = null;
      try {
        current.close(1000, 'Client disconnect');
      } catch {
        // ignore close errors
      }
    }
  }

  private updateStatus(nextStatus: WsConnectionStatus): void {
    this.status = nextStatus;
    this.callbacks.onStatusChange?.(this.status, this.getMetadata());
  }
}

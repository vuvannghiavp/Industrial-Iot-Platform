import {
  AlertItem,
  AuthTokens,
  DeviceControlRequest,
  DeviceControlResponse,
  DeviceItem,
  SensorHistoryQuery,
  SensorReading,
  UserProfile,
} from '../types/api';
import { TokenStore } from './tokenStore';
import { normalizeBaseUrl } from '../config/env';

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly detail?: string;

  constructor(message: string, status: number, code: string, detail?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  tokenStore: TokenStore;
  fetchImpl?: typeof fetch;
  onSessionExpired?: (reason: string) => void;
}

export interface ControlCommandResult {
  httpStatus: number;
  acceptedForMqtt: boolean;
  hardwareConfirmed: false;
  message: string;
  response?: DeviceControlResponse;
}

/**
 * Shared API Client giao tiếp với FastAPI Smart Home Backend:
 * - Gắn header Authorization: Bearer <access_token> cho các endpoint yêu cầu đăng nhập.
 * - Khi gặp HTTP 401, tự động gọi POST /api/v1/auth/refresh tối đa 1 lần (single-flight).
 * - Nếu refresh thành công, thử lại request ban đầu đúng 1 lần.
 * - Nếu refresh thất bại hoặc vẫn trả 401, xóa token và kích hoạt callback yêu cầu đăng nhập lại.
 * - Tuyệt đối không log mật khẩu, access_token hay refresh_token.
 */
export class SmartHomeApiClient {
  private baseUrl: string;
  private readonly tokenStore: TokenStore;
  private readonly fetchFn: typeof fetch;
  private readonly onSessionExpired?: (reason: string) => void;
  private refreshInFlight: Promise<boolean> | null = null;

  constructor(options: ApiClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.tokenStore = options.tokenStore;
    this.fetchFn = options.fetchImpl || globalThis.fetch.bind(globalThis);
    this.onSessionExpired = options.onSessionExpired;
  }

  public setBaseUrl(newBaseUrl: string): void {
    this.baseUrl = normalizeBaseUrl(newBaseUrl);
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * POST /api/v1/auth/login
   * Content-Type: application/x-www-form-urlencoded
   * Gửi username bằng email và password bằng mật khẩu.
   */
  public async login(email: string, password: string): Promise<AuthTokens> {
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      throw new ApiError('Vui lòng nhập đầy đủ email và mật khẩu.', 400, 'VALIDATION_ERROR');
    }

    const body = new URLSearchParams();
    body.set('username', trimmedEmail);
    body.set('password', password);

    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
      });
    } catch {
      throw new ApiError(
        `Không thể kết nối tới máy chủ API (${this.baseUrl}). Vui lòng kiểm tra backend FastAPI đang chạy.`,
        0,
        'NETWORK_ERROR'
      );
    }

    const payload = await this.safeParseJson(response);

    if (!response.ok) {
      const detail = this.extractDetail(payload);
      if (response.status === 401 || response.status === 400) {
        throw new ApiError(
          detail || 'Email hoặc mật khẩu không chính xác.',
          response.status,
          'INVALID_CREDENTIALS',
          detail
        );
      }
      throw new ApiError(
        detail || `Đăng nhập thất bại (HTTP ${response.status}).`,
        response.status,
        'LOGIN_FAILED',
        detail
      );
    }

    const tokens = payload as unknown as AuthTokens;
    if (!tokens || typeof tokens.access_token !== 'string' || typeof tokens.refresh_token !== 'string') {
      throw new ApiError('Phản hồi đăng nhập từ server thiếu token hợp lệ.', 500, 'INVALID_TOKEN_RESPONSE');
    }

    this.tokenStore.setTokens({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_type: tokens.token_type || 'bearer',
    });

    return tokens;
  }

  /**
   * POST /api/v1/auth/refresh
   * JSON: { "refresh_token": "..." }
   */
  public async refreshTokensOnce(): Promise<boolean> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = this.performTokenRefresh().finally(() => {
      this.refreshInFlight = null;
    });

    return this.refreshInFlight;
  }

  private async performTokenRefresh(): Promise<boolean> {
    const currentRefreshToken = this.tokenStore.getRefreshToken();
    if (!currentRefreshToken) {
      this.tokenStore.clearTokens();
      return false;
    }

    try {
      const response = await this.fetchFn(`${this.baseUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ refresh_token: currentRefreshToken }),
      });

      if (!response.ok) {
        this.tokenStore.clearTokens();
        return false;
      }

      const payload = (await this.safeParseJson(response)) as Partial<AuthTokens> | null;
      if (!payload || typeof payload.access_token !== 'string') {
        this.tokenStore.clearTokens();
        return false;
      }

      this.tokenStore.setTokens({
        access_token: payload.access_token,
        refresh_token: typeof payload.refresh_token === 'string' ? payload.refresh_token : currentRefreshToken,
        token_type: payload.token_type || 'bearer',
      });

      return true;
    } catch {
      this.tokenStore.clearTokens();
      return false;
    }
  }

  /**
   * Thực thi request cần xác thực Bearer token, tự động xử lý 401 bằng refresh tối đa 1 lần.
   */
  public async requestWithAuth<T>(
    path: string,
    init: RequestInit = {},
    allowRefreshRetry = true
  ): Promise<{ status: number; data: T }> {
    const accessToken = this.tokenStore.getAccessToken();
    if (!accessToken) {
      this.handleExpiredSession('Phiên đăng nhập không tồn tại. Vui lòng đăng nhập.');
      throw new ApiError('Chưa đăng nhập hoặc thiếu token xác thực.', 401, 'UNAUTHORIZED');
    }

    const headers = new Headers(init.headers || {});
    headers.set('Authorization', `Bearer ${accessToken}`);
    if (!headers.has('Accept')) {
      headers.set('Accept', 'application/json');
    }

    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        ...init,
        headers,
      });
    } catch {
      throw new ApiError(
        `Mất kết nối tới máy chủ (${this.baseUrl}). Vui lòng kiểm tra mạng hoặc trạng thái backend.`,
        0,
        'NETWORK_ERROR'
      );
    }

    if (response.status === 401) {
      if (allowRefreshRetry) {
        const refreshed = await this.refreshTokensOnce();
        if (refreshed) {
          // Thử lại đúng 1 lần với access_token mới
          return this.requestWithAuth<T>(path, init, false);
        }
      }
      this.handleExpiredSession('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
      throw new ApiError(
        'Phiên đăng nhập đã hết hạn (401). Vui lòng đăng nhập lại.',
        401,
        'SESSION_EXPIRED'
      );
    }

    const payload = await this.safeParseJson(response);

    if (!response.ok) {
      const detail = this.extractDetail(payload);
      if (response.status === 404) {
        throw new ApiError(
          detail || 'Không tìm thấy tài nguyên hoặc thiết bị trong cơ sở dữ liệu (404).',
          404,
          'NOT_FOUND',
          detail
        );
      }
      if (response.status === 503) {
        throw new ApiError(
          detail || 'Dịch vụ MQTT phía backend hiện chưa kết nối (503). Vui lòng thử lại sau.',
          503,
          'MQTT_UNAVAILABLE',
          detail
        );
      }
      throw new ApiError(
        detail || `Lỗi máy chủ API (HTTP ${response.status}).`,
        response.status,
        'API_ERROR',
        detail
      );
    }

    return {
      status: response.status,
      data: payload as T,
    };
  }

  /**
   * GET /api/v1/auth/me
   */
  public async getMe(): Promise<UserProfile> {
    const { data } = await this.requestWithAuth<UserProfile>('/api/v1/auth/me', {
      method: 'GET',
    });
    return data;
  }

  /**
   * GET /api/v1/devices
   */
  public async getDevices(): Promise<DeviceItem[]> {
    const { data } = await this.requestWithAuth<DeviceItem[]>('/api/v1/devices', {
      method: 'GET',
    });
    return Array.isArray(data) ? data : [];
  }

  /**
   * GET /api/v1/sensors/latest
   */
  public async getLatestSensors(): Promise<SensorReading[]> {
    const { data } = await this.requestWithAuth<SensorReading[]>('/api/v1/sensors/latest', {
      method: 'GET',
    });
    return Array.isArray(data) ? data : [];
  }

  /**
   * GET /api/v1/sensors/history?type={sensor_type}&start_time={unix_seconds}&end_time={unix_seconds}&interval=raw
   */
  public async getSensorHistory(query: SensorHistoryQuery): Promise<SensorReading[]> {
    const params = new URLSearchParams({
      type: query.type,
      start_time: String(Math.floor(query.start_time)),
      end_time: String(Math.floor(query.end_time)),
      interval: query.interval || 'raw',
    });
    const { data } = await this.requestWithAuth<SensorReading[]>(
      `/api/v1/sensors/history?${params.toString()}`,
      { method: 'GET' }
    );
    return Array.isArray(data) ? data : [];
  }

  /**
   * GET /api/v1/alerts?limit=100
   */
  public async getAlerts(limit = 100): Promise<AlertItem[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    const { data } = await this.requestWithAuth<AlertItem[]>(
      `/api/v1/alerts?${params.toString()}`,
      { method: 'GET' }
    );
    return Array.isArray(data) ? data : [];
  }

  /**
   * POST /api/v1/devices/{device_id}/control
   * JSON: { "action": "turn_on" | "turn_off", "target": "fan" | "light" }
   * Lưu ý quan trọng: HTTP 202 chỉ có nghĩa backend đã nhận lệnh để publish MQTT;
   * KHÔNG có nghĩa thiết bị vật lý đã xác nhận thực thi.
   */
  public async sendDeviceControl(
    deviceId: string,
    request: DeviceControlRequest
  ): Promise<ControlCommandResult> {
    if (!deviceId) {
      throw new ApiError('Thiếu mã thiết bị (device_id) khi gửi lệnh điều khiển.', 400, 'INVALID_DEVICE');
    }
    if (request.target !== 'fan' && request.target !== 'light') {
      throw new ApiError('Chỉ hỗ trợ điều khiển target "fan" hoặc "light".', 400, 'INVALID_TARGET');
    }
    if (request.action !== 'turn_on' && request.action !== 'turn_off') {
      throw new ApiError('Hành động điều khiển chỉ hỗ trợ "turn_on" hoặc "turn_off".', 400, 'INVALID_ACTION');
    }

    const encodedId = encodeURIComponent(deviceId);
    const { status, data } = await this.requestWithAuth<DeviceControlResponse>(
      `/api/v1/devices/${encodedId}/control`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: request.action,
          target: request.target,
        }),
      }
    );

    const actionLabel = request.action === 'turn_on' ? 'BẬT' : 'TẮT';
    const targetLabel = request.target === 'fan' ? 'Quạt' : 'Đèn';

    return {
      httpStatus: status,
      acceptedForMqtt: status === 202 || (status >= 200 && status < 300),
      hardwareConfirmed: false,
      message: `Đã gửi lệnh ${actionLabel} ${targetLabel} (HTTP ${status} — Backend đã đưa vào hàng đợi MQTT, đang chờ xác nhận từ thiết bị vật lý).`,
      response: data,
    };
  }

  private handleExpiredSession(reason: string): void {
    this.tokenStore.clearTokens();
    if (this.onSessionExpired) {
      this.onSessionExpired(reason);
    }
  }

  private async safeParseJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return { detail: text };
    }
  }

  private extractDetail(payload: unknown): string | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    const record = payload as Record<string, unknown>;
    if (typeof record.detail === 'string') return record.detail;
    if (typeof record.message === 'string') return record.message;
    if (Array.isArray(record.detail) && record.detail.length > 0) {
      const first = record.detail[0] as Record<string, unknown>;
      if (first && typeof first.msg === 'string') return first.msg;
    }
    return undefined;
  }
}

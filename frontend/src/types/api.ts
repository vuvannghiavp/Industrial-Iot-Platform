/**
 * Định nghĩa kiểu dữ liệu chuẩn giao tiếp với FastAPI Smart Home Backend
 * Tuyệt đối tuân thủ hợp đồng API thực tế, không tự suy diễn trạng thái phần cứng.
 */

export type DataSourceMode = 'live' | 'simulation';

export type SensorType = 'temperature' | 'humidity' | 'motion' | 'light';

export type HistoryInterval = 'raw' | '1m' | '5m' | '1h' | '1d';

export type ControlTarget = 'fan' | 'light';

export type ControlAction = 'turn_on' | 'turn_off';

/**
 * POST /api/v1/auth/login & POST /api/v1/auth/refresh response
 */
export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
}

/**
 * GET /api/v1/auth/me response
 */
export interface UserProfile {
  id?: string | number;
  email: string;
  username?: string;
  full_name?: string;
  is_active?: boolean;
  created_at?: string;
}

/**
 * GET /api/v1/devices response item
 */
export interface DeviceItem {
  id: string;
  gateway_id: string;
  name: string;
  kind: string;
  is_online: boolean;
  last_seen_at: string | null;
  fan_state?: boolean | null;
  light_state?: boolean | null;
}

/**
 * GET /api/v1/sensors/latest & GET /api/v1/sensors/history response item
 */
export interface SensorReading {
  time: string;
  device_id: string;
  sensor_type: SensorType;
  value: number;
}

/**
 * Tham số truy vấn GET /api/v1/sensors/history
 */
export interface SensorHistoryQuery {
  type: SensorType;
  start_time: number; // Unix timestamp in seconds
  end_time: number;   // Unix timestamp in seconds
  interval: HistoryInterval;
}

/**
 * GET /api/v1/alerts?limit=100 response item & WebSocket alert payload
 */
export interface AlertItem {
  id?: string | number;
  device_id?: string;
  gateway_id?: string;
  sensor_type?: SensorType | string;
  alert_type?: string;
  severity?: 'info' | 'warning' | 'critical' | string;
  message: string;
  value?: number;
  threshold?: number;
  created_at?: string;
  timestamp?: string;
  time?: string;
}

/**
 * POST /api/v1/devices/{device_id}/control request body
 */
export interface DeviceControlRequest {
  action: ControlAction;
  target: ControlTarget;
}

/**
 * POST /api/v1/devices/{device_id}/control response (HTTP 202 Accepted)
 */
export interface DeviceControlResponse {
  status?: string;
  message?: string;
  detail?: string;
  device_id?: string;
  target?: ControlTarget;
  action?: ControlAction;
}

/**
 * Tách biệt rõ ràng giữa:
 * 1. Trạng thái lệnh mong muốn (Desired Command State - gửi từ UI lên API/MQTT)
 * 2. Trạng thái thiết bị đã xác nhận từ phản hồi cuộn Modbus của gateway.
 */
export type CommandDispatchStatus =
  | 'idle'
  | 'sending'
  | 'queued_202'
  | 'confirmed'
  | 'error_401'
  | 'error_404'
  | 'error_503'
  | 'error_network';

export interface TargetControlState {
  device_id: string;
  target: ControlTarget;
  /** Trạng thái lệnh mong muốn cuối cùng mà người dùng đã chọn */
  desiredAction: ControlAction | null;
  /** Trạng thái gửi lệnh tới API/MQTT */
  dispatchStatus: CommandDispatchStatus;
  /** HTTP status code trả về gần nhất (VD: 202, 401, 404, 503) */
  httpStatus: number | null;
  /** Thông điệp mô tả rõ ràng cho người dùng */
  statusMessage: string;
  /** Thời điểm gửi lệnh gần nhất */
  lastCommandSentAt: string | null;
  /**
   * Trạng thái phần cứng thực tế đã xác nhận:
   * Trạng thái đọc thực tế từ cuộn Modbus của gateway.
   */
  confirmedHardwareState: 'on' | 'off' | 'unknown';
}

/**
 * WebSocket Telemetry payload
 */
export interface WsTelemetryPayload {
  device_id: string;
  gateway_id: string;
  timestamp: string;
  values: Partial<Record<SensorType, number>>;
  actuators?: Partial<Record<ControlTarget, boolean>>;
}

export interface WsDeviceStatusPayload {
  device_id: string;
  is_online: boolean;
  last_seen_at: string | null;
}

export interface WsTelemetryEvent {
  event: 'telemetry';
  data: WsTelemetryPayload;
}

export interface WsAlertEvent {
  event: 'alert';
  data: AlertItem;
}

export type WsIncomingEvent = WsTelemetryEvent | WsAlertEvent | Record<string, unknown>;

export type WsConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'auth_failed';

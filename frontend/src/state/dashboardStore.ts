import {
  AlertItem,
  ControlAction,
  ControlTarget,
  DataSourceMode,
  DeviceItem,
  HistoryInterval,
  SensorReading,
  SensorType,
  TargetControlState,
  UserProfile,
  WsConnectionStatus,
  WsTelemetryPayload,
} from '../types/api';
import { ApiError, SmartHomeApiClient } from '../services/apiClient';
import { TokenStore } from '../services/tokenStore';
import { TelemetryWebSocketClient, WsStatusMetadata } from '../services/wsClient';

export type ActiveTab = 'overview' | 'devices' | 'history' | 'alerts';

export interface TelemetryChartPoint {
  label: string;
  timestamp: string;
  device_id: string;
  temperature?: number;
  humidity?: number;
  light?: number;
  motion?: number;
}

export interface DashboardState {
  mode: DataSourceMode;
  activeTab: ActiveTab;
  isAuthenticated: boolean;
  authLoading: boolean;
  authError: string | null;
  sessionExpiredNotice: string | null;
  user: UserProfile | null;

  initialLoading: boolean;
  dashboardError: string | null;
  devices: DeviceItem[];
  selectedDeviceId: string | 'all';

  /** Map lưu giá trị cảm biến mới nhất theo khóa `${device_id}::${sensor_type}` */
  latestSensorsByDevice: Record<string, SensorReading>;
  /** Lịch sử chuỗi điểm gần nhất phục vụ biểu đồ realtime trên hero banner */
  realtimeTimeline: TelemetryChartPoint[];

  /**
   * Trạng thái điều khiển tách biệt rõ:
   * - desiredAction (lệnh mong muốn)
   * - dispatchStatus (trạng thái gửi HTTP/MQTT)
   * - confirmedHardwareState ('unknown' - vì backend chưa có API/ACK xác nhận phần cứng)
   */
  controlStates: Record<string, TargetControlState>;

  alerts: AlertItem[];
  alertsLoading: boolean;
  alertsError: string | null;

  historyFilter: {
    sensorType: SensorType;
    interval: HistoryInterval;
    lookbackHours: number;
    customStartUnix?: number;
    customEndUnix?: number;
  };
  historyPoints: SensorReading[];
  historyLoading: boolean;
  historyError: string | null;

  wsStatus: WsConnectionStatus;
  wsMeta: WsStatusMetadata;

  /** Cho phép mô phỏng lỗi 503/404 chỉ khi đang ở chế độ Dữ liệu mô phỏng (Demo) */
  simulationFaultMode: 'none' | 'mqtt_503' | 'device_404' | 'empty_devices';
}

export type StateListener = (state: DashboardState) => void;

const SENSOR_TYPES: SensorType[] = ['temperature', 'humidity', 'motion', 'light'];
const CONTROL_TARGETS: ControlTarget[] = ['fan', 'light'];

export function makeSensorKey(deviceId: string, sensorType: SensorType): string {
  return `${deviceId}::${sensorType}`;
}

export function makeControlKey(deviceId: string, target: ControlTarget): string {
  return `${deviceId}::${target}`;
}

export function createInitialControlState(
  deviceId: string,
  target: ControlTarget
): TargetControlState {
  return {
    device_id: deviceId,
    target,
    desiredAction: null,
    dispatchStatus: 'idle',
    httpStatus: null,
    statusMessage: 'Chưa gửi lệnh điều khiển trong phiên này.',
    lastCommandSentAt: null,
    confirmedHardwareState: 'unknown',
  };
}

export class DashboardStore {
  private state: DashboardState;
  private readonly listeners = new Set<StateListener>();
  private readonly tokenStore: TokenStore;
  private readonly apiClient: SmartHomeApiClient;
  private readonly wsClient: TelemetryWebSocketClient;
  private simulationTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    tokenStore: TokenStore,
    apiClient: SmartHomeApiClient,
    wsClient: TelemetryWebSocketClient
  ) {
    this.tokenStore = tokenStore;
    this.apiClient = apiClient;
    this.wsClient = wsClient;

    this.state = {
      mode: 'live',
      activeTab: 'overview',
      isAuthenticated: this.tokenStore.hasTokens(),
      authLoading: false,
      authError: null,
      sessionExpiredNotice: null,
      user: null,

      initialLoading: false,
      dashboardError: null,
      devices: [],
      selectedDeviceId: 'all',

      latestSensorsByDevice: {},
      realtimeTimeline: [],
      controlStates: {},

      alerts: [],
      alertsLoading: false,
      alertsError: null,

      historyFilter: {
        sensorType: 'temperature',
        interval: 'raw',
        lookbackHours: 6,
      },
      historyPoints: [],
      historyLoading: false,
      historyError: null,

      wsStatus: 'disconnected',
      wsMeta: {
        reconnectAttempt: 0,
        nextRetryDelayMs: null,
        lastPingSentAt: null,
        lastMessageReceivedAt: null,
        disconnectReason: null,
      },
      simulationFaultMode: 'none',
    };

    this.wsClient.setCallbacks({
      onStatusChange: (wsStatus, wsMeta) => {
        this.patchState({ wsStatus, wsMeta });
      },
      onTelemetry: (payload) => {
        this.applyRealtimeTelemetry(payload);
      },
      onAlert: (alert) => {
        this.prependRealtimeAlert(alert);
      },
    });
  }

  public getState(): DashboardState {
    return this.state;
  }

  public subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public setActiveTab(tab: ActiveTab): void {
    this.patchState({ activeTab: tab });
    if (tab === 'history' && this.state.historyPoints.length === 0 && !this.state.historyLoading) {
      void this.loadSensorHistory();
    }
  }

  public setSelectedDevice(deviceId: string | 'all'): void {
    this.patchState({ selectedDeviceId: deviceId });
  }

  /**
   * Xử lý khi phiên đăng nhập hết hạn (từ callback 401 sau khi refresh thất bại)
   */
  public handleSessionExpired(reason: string): void {
    this.stopSimulationLoop();
    this.wsClient.disconnect();
    this.tokenStore.clearTokens();
    this.patchState({
      isAuthenticated: false,
      user: null,
      authLoading: false,
      authError: null,
      sessionExpiredNotice: reason,
      wsStatus: 'disconnected',
    });
  }

  /**
   * Đăng nhập với FastAPI Backend thật (POST /api/v1/auth/login)
   */
  public async loginLive(email: string, password: string): Promise<boolean> {
    this.stopSimulationLoop();
    this.patchState({
      mode: 'live',
      authLoading: true,
      authError: null,
      sessionExpiredNotice: null,
    });

    try {
      await this.apiClient.login(email, password);
      this.patchState({
        isAuthenticated: true,
        authLoading: false,
        authError: null,
      });
      await this.bootstrapLiveDashboard(email);
      return true;
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : 'Đã xảy ra lỗi không xác định khi đăng nhập.';
      this.patchState({
        isAuthenticated: false,
        authLoading: false,
        authError: message,
      });
      return false;
    }
  }

  /**
   * Khởi tạo dữ liệu Dashboard thật:
   * Gọi GET /api/v1/devices và GET /api/v1/sensors/latest (kèm GET /api/v1/auth/me & GET /api/v1/alerts),
   * sau đó mở kết nối WebSocket realtime.
   */
  public async bootstrapLiveDashboard(fallbackEmail?: string): Promise<void> {
    if (this.state.mode !== 'live') return;

    this.patchState({
      initialLoading: true,
      dashboardError: null,
    });

    try {
      const [devicesResult, latestSensorsResult, meResult, alertsResult] = await Promise.allSettled([
        this.apiClient.getDevices(),
        this.apiClient.getLatestSensors(),
        this.apiClient.getMe(),
        this.apiClient.getAlerts(100),
      ]);

      // Nếu cả devices và sensors đều thất bại do lỗi mạng hoặc 401 đã xử lý:
      if (!this.tokenStore.hasTokens()) {
        return;
      }

      if (devicesResult.status === 'rejected' && latestSensorsResult.status === 'rejected') {
        const reason =
          devicesResult.reason instanceof Error
            ? devicesResult.reason.message
            : 'Không thể tải dữ liệu thiết bị và cảm biến từ backend.';
        this.patchState({
          initialLoading: false,
          dashboardError: reason,
        });
        return;
      }

      const devices = devicesResult.status === 'fulfilled' ? devicesResult.value : [];
      const latestSensors =
        latestSensorsResult.status === 'fulfilled' ? latestSensorsResult.value : [];
      const user: UserProfile =
        meResult.status === 'fulfilled' && meResult.value
          ? meResult.value
          : { email: fallbackEmail || 'operator@smarthome.local' };
      const alerts = alertsResult.status === 'fulfilled' ? alertsResult.value : [];

      const latestMap: Record<string, SensorReading> = {};
      for (const item of latestSensors) {
        if (item && item.device_id && item.sensor_type) {
          const key = makeSensorKey(item.device_id, item.sensor_type);
          const existing = latestMap[key];
          if (!existing || new Date(item.time).getTime() >= new Date(existing.time).getTime()) {
            latestMap[key] = item;
          }
        }
      }

      const controlStates: Record<string, TargetControlState> = { ...this.state.controlStates };
      for (const dev of devices) {
        for (const target of CONTROL_TARGETS) {
          const cKey = makeControlKey(dev.id, target);
          const current = controlStates[cKey] || createInitialControlState(dev.id, target);
          const reportedState = target === 'fan' ? dev.fan_state : dev.light_state;
          controlStates[cKey] = {
            ...current,
            confirmedHardwareState:
              typeof reportedState === 'boolean'
                ? reportedState ? 'on' : 'off'
                : current.confirmedHardwareState,
          };
        }
      }

      const partialError =
        devicesResult.status === 'rejected'
          ? `Lỗi tải danh sách thiết bị: ${(devicesResult.reason as Error)?.message}`
          : latestSensorsResult.status === 'rejected'
          ? `Lỗi tải dữ liệu cảm biến: ${(latestSensorsResult.reason as Error)?.message}`
          : null;

      const timeline = this.buildInitialTimelineFromReadings(latestSensors);

      this.patchState({
        user,
        devices,
        latestSensorsByDevice: latestMap,
        realtimeTimeline: timeline,
        controlStates,
        alerts,
        initialLoading: false,
        dashboardError: partialError,
      });

      // Kết nối WebSocket sau khi đã tải dữ liệu khởi tạo
      this.wsClient.connect();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Lỗi không xác định khi tải dữ liệu ban đầu.';
      this.patchState({
        initialLoading: false,
        dashboardError: msg,
      });
    }
  }

  /**
   * Áp dụng dữ liệu Telemetry nhận từ WebSocket:
   * - Giữ giá trị gần nhất theo device_id và sensor_type.
   * - Cập nhật trạng thái thiết bị (is_online = true, last_seen_at = timestamp).
   * - Chỉ cập nhật trạng thái quạt/đèn từ actuator state do gateway đọc từ Modbus.
   */
  public applyRealtimeTelemetry(payload: WsTelemetryPayload): void {
    const timestamp = payload.timestamp || new Date().toISOString();
    const deviceId = payload.device_id;
    const gatewayId = payload.gateway_id || 'pi-gateway-01';

    const updatedSensors = { ...this.state.latestSensorsByDevice };
    for (const sType of SENSOR_TYPES) {
      const rawVal = payload.values?.[sType];
      if (typeof rawVal === 'number' && !Number.isNaN(rawVal)) {
        const key = makeSensorKey(deviceId, sType);
        updatedSensors[key] = {
          time: timestamp,
          device_id: deviceId,
          sensor_type: sType,
          value: rawVal,
        };
      }
    }

    // Cập nhật hoặc bổ sung thiết bị vào danh sách khi nhận telemetry thực tế
    let foundDevice = false;
    const updatedDevices = this.state.devices.map((dev) => {
      if (dev.id === deviceId) {
        foundDevice = true;
        return {
          ...dev,
          gateway_id: gatewayId || dev.gateway_id,
          is_online: true,
          last_seen_at: timestamp,
          fan_state:
            typeof payload.actuators?.fan === 'boolean' ? payload.actuators.fan : dev.fan_state,
          light_state:
            typeof payload.actuators?.light === 'boolean' ? payload.actuators.light : dev.light_state,
        };
      }
      return dev;
    });

    if (!foundDevice && !(this.state.mode === 'simulation' && this.state.simulationFaultMode === 'empty_devices')) {
      updatedDevices.push({
        id: deviceId,
        gateway_id: gatewayId,
        name: `Node ${deviceId.toUpperCase()}`,
        kind: 'sensor_actuator_node',
        is_online: true,
        last_seen_at: timestamp,
        fan_state: payload.actuators?.fan ?? null,
        light_state: payload.actuators?.light ?? null,
      });
    }

    const updatedControls = { ...this.state.controlStates };
    for (const target of CONTROL_TARGETS) {
      const cKey = makeControlKey(deviceId, target);
      const reportedState = payload.actuators?.[target];
      const current = updatedControls[cKey] || createInitialControlState(deviceId, target);
      if (typeof reportedState === 'boolean') {
        const confirmedHardwareState = reportedState ? 'on' : 'off';
        const desiredMatches =
          current.desiredAction === (reportedState ? 'turn_on' : 'turn_off');
        updatedControls[cKey] = {
          ...current,
          confirmedHardwareState,
          dispatchStatus:
            current.dispatchStatus === 'sending'
              ? current.dispatchStatus
              : desiredMatches
                ? 'confirmed'
                : current.dispatchStatus === 'queued_202'
                  ? 'idle'
                  : current.dispatchStatus,
          statusMessage: desiredMatches
            ? `Gateway đã đọc cuộn Modbus và xác nhận ${target === 'fan' ? 'quạt' : 'đèn'} đang ${reportedState ? 'BẬT' : 'TẮT'}.`
            : `Trạng thái phần cứng hiện tại: ${reportedState ? 'BẬT' : 'TẮT'} (đã đọc từ Modbus).`,
        };
      } else if (!updatedControls[cKey]) {
        updatedControls[cKey] = current;
      }
    }

    const timeLabel = this.formatShortTime(timestamp);
    const nextPoint: TelemetryChartPoint = {
      label: timeLabel,
      timestamp,
      device_id: deviceId,
      temperature: payload.values?.temperature,
      humidity: payload.values?.humidity,
      light: payload.values?.light,
      motion: payload.values?.motion,
    };

    const hasSensorReading = SENSOR_TYPES.some(
      (sensorType) => typeof payload.values?.[sensorType] === 'number'
    );
    const nextTimeline = hasSensorReading
      ? [...this.state.realtimeTimeline, nextPoint].slice(-20)
      : this.state.realtimeTimeline;

    this.patchState({
      devices: updatedDevices,
      latestSensorsByDevice: updatedSensors,
      controlStates: updatedControls,
      realtimeTimeline: nextTimeline,
    });
  }

  public prependRealtimeAlert(alert: AlertItem): void {
    const normalized: AlertItem = {
      id: alert.id || `ws-alert-${Date.now()}`,
      device_id: alert.device_id || 'stm32-01',
      gateway_id: alert.gateway_id || 'pi-gateway-01',
      sensor_type: alert.sensor_type || alert.alert_type || 'system',
      severity: alert.severity || 'warning',
      message: alert.message || 'Cảnh báo vượt ngưỡng cảm biến',
      value: alert.value,
      created_at: alert.created_at || alert.timestamp || alert.time || new Date().toISOString(),
    };

    this.patchState({
      alerts: [normalized, ...this.state.alerts].slice(0, 100),
    });
  }

  /**
   * Gửi lệnh điều khiển Quạt (fan) hoặc Đèn (light):
   * - Tách rõ "desiredAction" (Trạng thái lệnh mong muốn) và "confirmedHardwareState" ('unknown').
   * - Không bao giờ coi HTTP 202 là trạng thái ON/OFF vật lý đã được xác nhận.
   */
  public async sendControlCommand(
    deviceId: string,
    target: ControlTarget,
    action: ControlAction
  ): Promise<TargetControlState> {
    const cKey = makeControlKey(deviceId, target);
    const targetName = target === 'fan' ? 'Quạt' : 'Đèn';
    const actionName = action === 'turn_on' ? 'BẬT' : 'TẮT';

    const sendingState: TargetControlState = {
      device_id: deviceId,
      target,
      desiredAction: action,
      dispatchStatus: 'sending',
      httpStatus: null,
      statusMessage: `Đang gửi lệnh ${actionName} ${targetName} tới backend...`,
      lastCommandSentAt: new Date().toISOString(),
      confirmedHardwareState:
        this.state.controlStates[cKey]?.confirmedHardwareState || 'unknown',
    };

    this.patchState({
      controlStates: {
        ...this.state.controlStates,
        [cKey]: sendingState,
      },
    });

    // Xử lý riêng nếu đang ở chế độ Dữ liệu mô phỏng (Demo)
    if (this.state.mode === 'simulation') {
      await new Promise((r) => setTimeout(r, 280));
      if (this.state.simulationFaultMode === 'mqtt_503') {
        const err503: TargetControlState = {
          ...sendingState,
          dispatchStatus: 'error_503',
          httpStatus: 503,
          statusMessage:
            'Lỗi 503 (Mô phỏng): MQTT Broker phía backend chưa kết nối. Lệnh chưa được đẩy vào hàng đợi.',
        };
        this.patchState({
          controlStates: { ...this.state.controlStates, [cKey]: err503 },
        });
        return err503;
      }
      if (this.state.simulationFaultMode === 'device_404') {
        const err404: TargetControlState = {
          ...sendingState,
          dispatchStatus: 'error_404',
          httpStatus: 404,
          statusMessage: 'Lỗi 404 (Mô phỏng): Thiết bị chưa tồn tại trong cơ sở dữ liệu.',
        };
        this.patchState({
          controlStates: { ...this.state.controlStates, [cKey]: err404 },
        });
        return err404;
      }

      const simQueued: TargetControlState = {
        ...sendingState,
        dispatchStatus: 'queued_202',
        httpStatus: 202,
        statusMessage: `Đã gửi lệnh ${actionName} ${targetName} / Đang chờ xác nhận (HTTP 202 — Backend đã nhận lệnh publish MQTT, chưa có phản hồi từ phần cứng).`,
        confirmedHardwareState: 'unknown',
      };
      this.patchState({
        controlStates: { ...this.state.controlStates, [cKey]: simQueued },
      });
      return simQueued;
    }

    // Chế độ API Thật (Live API)
    try {
      const result = await this.apiClient.sendDeviceControl(deviceId, {
        target,
        action,
      });

      const nextState: TargetControlState = {
        device_id: deviceId,
        target,
        desiredAction: action,
        dispatchStatus: 'queued_202',
        httpStatus: result.httpStatus,
        statusMessage: `Đã gửi lệnh ${actionName} ${targetName} / Đang chờ xác nhận (HTTP ${result.httpStatus}: Backend đã nhận lệnh publish MQTT, thiết bị vật lý chưa gửi xác nhận).`,
        lastCommandSentAt: sendingState.lastCommandSentAt,
        confirmedHardwareState: this.state.controlStates[cKey]?.confirmedHardwareState || 'unknown',
      };
      const latestControlState = this.state.controlStates[cKey];
      const alreadyConfirmed =
        latestControlState !== sendingState &&
        latestControlState?.confirmedHardwareState !== 'unknown' &&
        (latestControlState.confirmedHardwareState === 'on') === (action === 'turn_on');
      if (alreadyConfirmed) {
        nextState.dispatchStatus = 'confirmed';
        nextState.statusMessage = `Gateway đã xác nhận ${targetName} ${action === 'turn_on' ? 'BẬT' : 'TẮT'} qua trạng thái Modbus.`;
      } else if (latestControlState !== sendingState) {
        nextState.confirmedHardwareState = latestControlState?.confirmedHardwareState || 'unknown';
      }

      this.patchState({
        controlStates: {
          ...this.state.controlStates,
          [cKey]: nextState,
        },
      });
      return nextState;
    } catch (err) {
      let dispatchStatus: TargetControlState['dispatchStatus'] = 'error_network';
      let httpStatus: number | null = null;
      let statusMessage = 'Lỗi kết nối mạng khi gửi lệnh điều khiển. Vui lòng thử lại.';

      if (err instanceof ApiError) {
        httpStatus = err.status || null;
        if (err.status === 401) {
          dispatchStatus = 'error_401';
          statusMessage = 'Phiên đăng nhập hết hạn (401). Vui lòng đăng nhập lại.';
        } else if (err.status === 404) {
          dispatchStatus = 'error_404';
          statusMessage = `Lỗi 404: Thiết bị "${deviceId}" chưa có trong DB backend.`;
        } else if (err.status === 503) {
          dispatchStatus = 'error_503';
          statusMessage =
            'Lỗi 503: MQTT Broker phía backend chưa kết nối. Không thể publish lệnh lúc này.';
        } else {
          statusMessage = err.message;
        }
      }

      const failedState: TargetControlState = {
        device_id: deviceId,
        target,
        desiredAction: action,
        dispatchStatus,
        httpStatus,
        statusMessage,
        lastCommandSentAt: sendingState.lastCommandSentAt,
        confirmedHardwareState: sendingState.confirmedHardwareState,
      };

      this.patchState({
        controlStates: {
          ...this.state.controlStates,
          [cKey]: failedState,
        },
      });
      return failedState;
    }
  }

  /**
   * Tải lịch sử cảm biến:
   * GET /api/v1/sensors/history?type={sensor_type}&start_time={unix_seconds}&end_time={unix_seconds}&interval=raw
   */
  public async loadSensorHistory(overrides?: Partial<DashboardState['historyFilter']>): Promise<void> {
    const nextFilter = {
      ...this.state.historyFilter,
      ...(overrides || {}),
    };

    const endUnix = nextFilter.customEndUnix ?? Math.floor(Date.now() / 1000);
    const startUnix =
      nextFilter.customStartUnix ?? endUnix - nextFilter.lookbackHours * 3600;

    this.patchState({
      historyFilter: nextFilter,
      historyLoading: true,
      historyError: null,
    });

    if (this.state.mode === 'simulation') {
      const points = this.generateSimulatedHistory(
        nextFilter.sensorType,
        startUnix,
        endUnix
      );
      this.patchState({
        historyPoints: points,
        historyLoading: false,
        historyError: null,
      });
      return;
    }

    try {
      const points = await this.apiClient.getSensorHistory({
        type: nextFilter.sensorType,
        start_time: startUnix,
        end_time: endUnix,
        interval: nextFilter.interval,
      });
      this.patchState({
        historyPoints: points,
        historyLoading: false,
        historyError: null,
      });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Không thể tải lịch sử cảm biến từ backend.';
      this.patchState({
        historyPoints: [],
        historyLoading: false,
        historyError: message,
      });
    }
  }

  /**
   * Tải lại danh sách cảnh báo GET /api/v1/alerts?limit=100
   */
  public async reloadAlerts(): Promise<void> {
    if (this.state.mode === 'simulation') return;
    this.patchState({ alertsLoading: true, alertsError: null });
    try {
      const alerts = await this.apiClient.getAlerts(100);
      this.patchState({ alerts, alertsLoading: false, alertsError: null });
    } catch (err) {
      this.patchState({
        alertsLoading: false,
        alertsError: err instanceof Error ? err.message : 'Không thể tải danh sách cảnh báo.',
      });
    }
  }

  /**
   * Đăng xuất:
   * Xóa token đã lưu, đóng WebSocket, dừng timer và quay về trang login.
   */
  public logout(): void {
    this.stopSimulationLoop();
    this.wsClient.disconnect();
    this.tokenStore.clearTokens();

    this.patchState({
      mode: 'live',
      isAuthenticated: false,
      authLoading: false,
      authError: null,
      sessionExpiredNotice: null,
      user: null,
      devices: [],
      latestSensorsByDevice: {},
      realtimeTimeline: [],
      controlStates: {},
      alerts: [],
      historyPoints: [],
      dashboardError: null,
      wsStatus: 'disconnected',
    });
  }

  /**
   * Chuyển sang chế độ "Dữ liệu mô phỏng (Demo)" — tách biệt hoàn toàn với API thật.
   */
  public enterSimulationMode(): void {
    this.wsClient.disconnect();
    this.stopSimulationLoop();

    const now = new Date();
    const isoNow = now.toISOString();

    const demoDevices: DeviceItem[] = [
      {
        id: 'stm32-01',
        gateway_id: 'pi-gateway-01',
        name: 'Phòng Khách · Trạm Cảm Biến Chính',
        kind: 'stm32_node',
        is_online: true,
        last_seen_at: isoNow,
      },
      {
        id: 'stm32-02',
        gateway_id: 'pi-gateway-01',
        name: 'Phòng Ngủ Master · Node Khí Hậu',
        kind: 'stm32_node',
        is_online: true,
        last_seen_at: new Date(now.getTime() - 18000).toISOString(),
      },
      {
        id: 'esp32-03',
        gateway_id: 'pi-gateway-02',
        name: 'Hành Lang & Sân Thượng · Node Ánh Sáng',
        kind: 'esp32_sensor',
        is_online: false,
        last_seen_at: new Date(now.getTime() - 42 * 60 * 1000).toISOString(),
      },
    ];

    const demoSensors: Record<string, SensorReading> = {
      [makeSensorKey('stm32-01', 'temperature')]: {
        time: isoNow,
        device_id: 'stm32-01',
        sensor_type: 'temperature',
        value: 25.6,
      },
      [makeSensorKey('stm32-01', 'humidity')]: {
        time: isoNow,
        device_id: 'stm32-01',
        sensor_type: 'humidity',
        value: 61,
      },
      [makeSensorKey('stm32-01', 'light')]: {
        time: isoNow,
        device_id: 'stm32-01',
        sensor_type: 'light',
        value: 340,
      },
      [makeSensorKey('stm32-01', 'motion')]: {
        time: isoNow,
        device_id: 'stm32-01',
        sensor_type: 'motion',
        value: 1,
      },
      [makeSensorKey('stm32-02', 'temperature')]: {
        time: isoNow,
        device_id: 'stm32-02',
        sensor_type: 'temperature',
        value: 24.1,
      },
      [makeSensorKey('stm32-02', 'humidity')]: {
        time: isoNow,
        device_id: 'stm32-02',
        sensor_type: 'humidity',
        value: 56,
      },
      [makeSensorKey('stm32-02', 'light')]: {
        time: isoNow,
        device_id: 'stm32-02',
        sensor_type: 'light',
        value: 85,
      },
      [makeSensorKey('stm32-02', 'motion')]: {
        time: isoNow,
        device_id: 'stm32-02',
        sensor_type: 'motion',
        value: 0,
      },
      [makeSensorKey('esp32-03', 'temperature')]: {
        time: new Date(now.getTime() - 42 * 60 * 1000).toISOString(),
        device_id: 'esp32-03',
        sensor_type: 'temperature',
        value: 28.4,
      },
      [makeSensorKey('esp32-03', 'humidity')]: {
        time: new Date(now.getTime() - 42 * 60 * 1000).toISOString(),
        device_id: 'esp32-03',
        sensor_type: 'humidity',
        value: 68,
      },
      [makeSensorKey('esp32-03', 'light')]: {
        time: new Date(now.getTime() - 42 * 60 * 1000).toISOString(),
        device_id: 'esp32-03',
        sensor_type: 'light',
        value: 520,
      },
      [makeSensorKey('esp32-03', 'motion')]: {
        time: new Date(now.getTime() - 42 * 60 * 1000).toISOString(),
        device_id: 'esp32-03',
        sensor_type: 'motion',
        value: 0,
      },
    };

    const controlStates: Record<string, TargetControlState> = {};
    for (const dev of demoDevices) {
      for (const target of CONTROL_TARGETS) {
        controlStates[makeControlKey(dev.id, target)] = createInitialControlState(
          dev.id,
          target
        );
      }
    }

    const timeline: TelemetryChartPoint[] = [];
    for (let i = 15; i >= 0; i--) {
      const ptTime = new Date(now.getTime() - i * 15 * 60 * 1000);
      timeline.push({
        label: this.formatShortTime(ptTime.toISOString()),
        timestamp: ptTime.toISOString(),
        device_id: 'stm32-01',
        temperature: Number((24.5 + Math.sin(i * 0.45) * 2.1).toFixed(1)),
        humidity: Math.round(58 + Math.cos(i * 0.35) * 7),
        light: Math.round(120 + ((15 - i) % 8) * 45),
        motion: i % 4 === 0 ? 1 : 0,
      });
    }

    const demoAlerts: AlertItem[] = [
      {
        id: 'sim-alert-1',
        device_id: 'esp32-03',
        gateway_id: 'pi-gateway-02',
        sensor_type: 'temperature',
        severity: 'warning',
        message: '[Dữ liệu mô phỏng] Nhiệt độ khu vực Hành Lang đạt 28.4°C trước khi node mất kết nối.',
        value: 28.4,
        created_at: new Date(now.getTime() - 40 * 60 * 1000).toISOString(),
      },
      {
        id: 'sim-alert-2',
        device_id: 'stm32-01',
        gateway_id: 'pi-gateway-01',
        sensor_type: 'motion',
        severity: 'info',
        message: '[Dữ liệu mô phỏng] Phát hiện chuyển động tại Phòng Khách (motion = 1).',
        value: 1,
        created_at: new Date(now.getTime() - 4 * 60 * 1000).toISOString(),
      },
    ];

    this.patchState({
      mode: 'simulation',
      isAuthenticated: true,
      authLoading: false,
      authError: null,
      sessionExpiredNotice: null,
      user: {
        id: 'demo-operator',
        email: 'demo.simulation@smarthome.local',
        full_name: 'Chế độ Dữ liệu Mô phỏng (Sandbox)',
      },
      initialLoading: false,
      dashboardError: null,
      devices: demoDevices,
      selectedDeviceId: 'all',
      latestSensorsByDevice: demoSensors,
      realtimeTimeline: timeline,
      controlStates,
      alerts: demoAlerts,
      wsStatus: 'connected',
      wsMeta: {
        reconnectAttempt: 0,
        nextRetryDelayMs: null,
        lastPingSentAt: isoNow,
        lastMessageReceivedAt: isoNow,
        disconnectReason: null,
      },
      simulationFaultMode: 'none',
    });

    void this.loadSensorHistory();

    this.simulationTimer = setInterval(() => {
      if (this.state.mode !== 'simulation' || this.state.simulationFaultMode === 'empty_devices') {
        return;
      }
      this.emitSimulatedTelemetryTick();
    }, 5000);
  }

  public setSimulationFaultMode(
    faultMode: DashboardState['simulationFaultMode']
  ): void {
    if (this.state.mode !== 'simulation') return;
    if (faultMode === 'empty_devices') {
      this.patchState({
        simulationFaultMode: faultMode,
        devices: [],
        latestSensorsByDevice: {},
      });
      return;
    }
    const wasEmpty = this.state.simulationFaultMode === 'empty_devices';
    this.patchState({ simulationFaultMode: faultMode });
    if (wasEmpty) {
      this.enterSimulationMode();
      this.patchState({ simulationFaultMode: faultMode });
    }
  }

  public emitSimulatedTelemetryTick(): void {
    if (this.state.mode !== 'simulation') return;
    const nowIso = new Date().toISOString();
    const temp = Number((24.8 + (Math.random() * 2.4 - 0.8)).toFixed(1));
    const humidity = Math.round(57 + (Math.random() * 10 - 4));
    const light = Math.round(280 + (Math.random() * 140 - 70));
    const motion = Math.random() > 0.65 ? 1 : 0;

    this.applyRealtimeTelemetry({
      device_id: 'stm32-01',
      gateway_id: 'pi-gateway-01',
      timestamp: nowIso,
      values: {
        temperature: temp,
        humidity,
        light,
        motion,
      },
    });
    this.patchState({
      wsMeta: {
        ...this.state.wsMeta,
        lastPingSentAt: nowIso,
        lastMessageReceivedAt: nowIso,
      },
    });
  }

  private buildInitialTimelineFromReadings(readings: SensorReading[]): TelemetryChartPoint[] {
    if (!readings.length) return [];
    const grouped = new Map<string, TelemetryChartPoint>();
    for (const r of readings) {
      const key = `${r.device_id}_${r.time}`;
      const existing = grouped.get(key) || {
        label: this.formatShortTime(r.time),
        timestamp: r.time,
        device_id: r.device_id,
      };
      if (r.sensor_type === 'temperature') existing.temperature = r.value;
      if (r.sensor_type === 'humidity') existing.humidity = r.value;
      if (r.sensor_type === 'light') existing.light = r.value;
      if (r.sensor_type === 'motion') existing.motion = r.value;
      grouped.set(key, existing);
    }
    return Array.from(grouped.values()).slice(-20);
  }

  private generateSimulatedHistory(
    sensorType: SensorType,
    startUnix: number,
    endUnix: number
  ): SensorReading[] {
    const count = 24;
    const step = Math.max(60, Math.floor((endUnix - startUnix) / count));
    const result: SensorReading[] = [];
    for (let i = 0; i <= count; i++) {
      const t = (startUnix + i * step) * 1000;
      let value = 0;
      if (sensorType === 'temperature') {
        value = Number((24.2 + Math.sin(i * 0.4) * 2.3).toFixed(1));
      } else if (sensorType === 'humidity') {
        value = Math.round(58 + Math.cos(i * 0.35) * 8);
      } else if (sensorType === 'light') {
        value = Math.round(150 + Math.sin(i * 0.3) * 120 + 80);
      } else {
        value = i % 5 === 0 ? 1 : 0;
      }
      result.push({
        time: new Date(t).toISOString(),
        device_id: 'stm32-01',
        sensor_type: sensorType,
        value,
      });
    }
    return result;
  }

  private formatShortTime(isoString: string): string {
    try {
      const d = new Date(isoString);
      if (Number.isNaN(d.getTime())) return '--:--';
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      return `${hh}:${mm}:${ss}`;
    } catch {
      return '--:--';
    }
  }

  private stopSimulationLoop(): void {
    if (this.simulationTimer !== null) {
      clearInterval(this.simulationTimer);
      this.simulationTimer = null;
    }
  }

  private patchState(partial: Partial<DashboardState>): void {
    this.state = {
      ...this.state,
      ...partial,
    };
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}

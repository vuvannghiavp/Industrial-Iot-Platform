import test from 'node:test';
import assert from 'node:assert/strict';

import { TokenStore, StorageLike } from '../src/services/tokenStore';
import { SmartHomeApiClient, ApiError } from '../src/services/apiClient';
import { TelemetryWebSocketClient, WebSocketLike } from '../src/services/wsClient';
import { DashboardStore, makeControlKey, makeSensorKey } from '../src/state/dashboardStore';

class MemoryStorage implements StorageLike {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

class MockWebSocket implements WebSocketLike {
  public readyState = 0; // CONNECTING
  public onopen: ((ev: unknown) => void) | null = null;
  public onmessage: ((ev: { data: string }) => void) | null = null;
  public onerror: ((ev: unknown) => void) | null = null;
  public onclose: ((ev: { code?: number; reason?: string; wasClean?: boolean }) => void) | null = null;
  public sentMessages: string[] = [];
  public closedWith: { code?: number; reason?: string } | null = null;

  constructor(public readonly url: string, public readonly protocols: string[] = []) {}

  public openServerSide(): void {
    this.readyState = 1; // OPEN
    this.onopen?.({});
  }

  public emitServerMessage(payload: unknown): void {
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.onmessage?.({ data: raw });
  }

  public closeServerSide(code = 1006, reason = 'Abnormal closure'): void {
    this.readyState = 3; // CLOSED
    this.onclose?.({ code, reason, wasClean: false });
  }

  public send(data: string): void {
    this.sentMessages.push(data);
  }

  public close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closedWith = { code, reason };
    this.onclose?.({ code, reason, wasClean: true });
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('1. Luồng Login: gửi x-www-form-urlencoded (username=email, password) và lưu token an toàn', async () => {
  const storage = new MemoryStorage();
  const tokenStore = new TokenStore(storage);

  let capturedUrl = '';
  let capturedContentType = '';
  let capturedBody = '';

  const mockFetch: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
    const headers = new Headers(init?.headers || {});
    capturedContentType = headers.get('Content-Type') || '';
    capturedBody = String(init?.body || '');

    return jsonResponse(200, {
      access_token: 'jwt-access-123',
      refresh_token: 'jwt-refresh-456',
      token_type: 'bearer',
    });
  };

  const apiClient = new SmartHomeApiClient({
    baseUrl: 'http://localhost:8000',
    tokenStore,
    fetchImpl: mockFetch,
  });

  const result = await apiClient.login('engineer@smarthome.vn', 'SecretPass!99');

  assert.equal(capturedUrl, 'http://localhost:8000/api/v1/auth/login');
  assert.equal(capturedContentType, 'application/x-www-form-urlencoded');

  const params = new URLSearchParams(capturedBody);
  assert.equal(params.get('username'), 'engineer@smarthome.vn');
  assert.equal(params.get('password'), 'SecretPass!99');

  assert.equal(result.access_token, 'jwt-access-123');
  assert.equal(tokenStore.getAccessToken(), 'jwt-access-123');
  assert.equal(tokenStore.getRefreshToken(), 'jwt-refresh-456');
});

test('2. Luồng tải Devices & Sensors ban đầu và xử lý dữ liệu rỗng (không tự tạo thiết bị giả)', async () => {
  const tokenStore = new TokenStore(new MemoryStorage());
  tokenStore.setTokens({
    access_token: 'valid-token',
    refresh_token: 'valid-refresh',
    token_type: 'bearer',
  });

  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/api/v1/devices')) {
      return jsonResponse(200, []);
    }
    if (url.endsWith('/api/v1/sensors/latest')) {
      return jsonResponse(200, []);
    }
    if (url.endsWith('/api/v1/auth/me')) {
      return jsonResponse(200, { email: 'user@smarthome.vn' });
    }
    if (url.includes('/api/v1/alerts')) {
      return jsonResponse(200, []);
    }
    return jsonResponse(404, { detail: 'Not found' });
  };

  const apiClient = new SmartHomeApiClient({
    baseUrl: 'http://localhost:8000',
    tokenStore,
    fetchImpl: mockFetch,
  });

  const sockets: MockWebSocket[] = [];
  const wsClient = new TelemetryWebSocketClient({
    wsBaseUrl: 'ws://localhost:8000',
    tokenStore,
    wsFactory: (url, protocols) => {
      const ws = new MockWebSocket(url, protocols);
      sockets.push(ws);
      return ws;
    },
  });

  const store = new DashboardStore(tokenStore, apiClient, wsClient);
  await store.bootstrapLiveDashboard();

  const state = store.getState();
  assert.equal(state.mode, 'live');
  assert.equal(state.devices.length, 0, 'Không được tự bịa thiết bị khi backend trả mảng rỗng');
  assert.equal(Object.keys(state.latestSensorsByDevice).length, 0);
  assert.equal(sockets.length, 1, 'Phải kết nối WebSocket sau khi bootstrap');
  assert.equal(sockets[0].url, 'ws://localhost:8000/ws/telemetry');
  assert.deepEqual(sockets[0].protocols, ['bearer', 'valid-token']);

  wsClient.disconnect();
});

test('3. Luồng WebSocket: gửi ping duy trì loop, cập nhật telemetry theo device_id & sensor_type, và reconnect backoff', async (t) => {
  const tokenStore = new TokenStore(new MemoryStorage());
  tokenStore.setTokens({
    access_token: 'ws-jwt-token',
    refresh_token: 'ws-refresh-token',
    token_type: 'bearer',
  });

  const apiClient = new SmartHomeApiClient({
    baseUrl: 'http://localhost:8000',
    tokenStore,
    fetchImpl: async () => jsonResponse(200, []),
  });

  const createdSockets: MockWebSocket[] = [];
  const wsClient = new TelemetryWebSocketClient({
    wsBaseUrl: 'ws://localhost:8000',
    tokenStore,
    pingIntervalMs: 5000,
    baseReconnectDelayMs: 1000,
    maxReconnectDelayMs: 16000,
    wsFactory: (url, protocols) => {
      const sock = new MockWebSocket(url, protocols);
      createdSockets.push(sock);
      return sock;
    },
  });

  const store = new DashboardStore(tokenStore, apiClient, wsClient);
  t.after(() => store.logout());
  wsClient.connect();

  assert.equal(createdSockets.length, 1);
  const ws = createdSockets[0];
  ws.openServerSide();

  assert.equal(store.getState().wsStatus, 'connected');
  assert.ok(ws.sentMessages.includes('ping'), 'Phải gửi chuỗi "ping" khi mở kết nối WebSocket');

  // Phát gói telemetry từ backend
  ws.emitServerMessage({
    event: 'telemetry',
    data: {
      device_id: 'stm32-01',
      gateway_id: 'pi-gateway-01',
      timestamp: '2026-10-14T03:00:00Z',
      values: {
        temperature: 26.4,
        humidity: 62,
        light: 240,
        motion: 1,
      },
      actuators: { fan: true, light: false },
    },
  });

  const stateAfterTelemetry = store.getState();
  assert.equal(
    stateAfterTelemetry.latestSensorsByDevice[makeSensorKey('stm32-01', 'temperature')]?.value,
    26.4
  );
  assert.equal(
    stateAfterTelemetry.latestSensorsByDevice[makeSensorKey('stm32-01', 'humidity')]?.value,
    62
  );
  assert.equal(
    stateAfterTelemetry.latestSensorsByDevice[makeSensorKey('stm32-01', 'light')]?.value,
    240
  );
  assert.equal(
    stateAfterTelemetry.latestSensorsByDevice[makeSensorKey('stm32-01', 'motion')]?.value,
    1
  );
  assert.equal(
    stateAfterTelemetry.controlStates[makeControlKey('stm32-01', 'fan')]?.confirmedHardwareState,
    'on'
  );
  assert.equal(
    stateAfterTelemetry.controlStates[makeControlKey('stm32-01', 'light')]?.confirmedHardwareState,
    'off'
  );

  // Phát sự kiện alert qua WebSocket
  ws.emitServerMessage({
    event: 'alert',
    data: {
      id: 'alert-99',
      device_id: 'stm32-01',
      severity: 'critical',
      message: 'Nhiệt độ vượt ngưỡng an toàn',
    },
  });
  assert.equal(store.getState().alerts.length, 1);
  assert.equal(store.getState().alerts[0].message, 'Nhiệt độ vượt ngưỡng an toàn');

  // Kiểm tra tính toán backoff khi mất kết nối
  assert.equal(wsClient.computeBackoffDelay(1), 1000);
  assert.equal(wsClient.computeBackoffDelay(2), 2000);
  assert.equal(wsClient.computeBackoffDelay(3), 4000);

  ws.closeServerSide(1006, 'Network drop');
  assert.equal(store.getState().wsStatus, 'reconnecting');
  assert.equal(store.getState().wsMeta.reconnectAttempt, 1);
  assert.equal(store.getState().wsMeta.nextRetryDelayMs, 1000);

  // Dọn dẹp timer khi logout
  store.logout();
  assert.equal(store.getState().wsStatus, 'disconnected');
  assert.equal(tokenStore.hasTokens(), false);
});

test('4. Luồng Điều khiển Quạt/Đèn: HTTP 202 chờ xác nhận Modbus, sau đó xử lý lỗi 503/404', async () => {
  const tokenStore = new TokenStore(new MemoryStorage());
  tokenStore.setTokens({
    access_token: 'ctrl-token',
    refresh_token: 'ctrl-refresh',
    token_type: 'bearer',
  });

  let mockStatusToReturn = 202;
  let lastControlPayload: Record<string, string> | null = null;

  const apiClient = new SmartHomeApiClient({
    baseUrl: 'http://localhost:8000',
    tokenStore,
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/v1/devices/stm32-01/control')) {
        lastControlPayload = JSON.parse(String(init?.body || '{}'));
        if (mockStatusToReturn === 202) {
          return jsonResponse(202, { status: 'queued' });
        }
        if (mockStatusToReturn === 503) {
          return jsonResponse(503, { detail: 'MQTT client is not connected' });
        }
        if (mockStatusToReturn === 404) {
          return jsonResponse(404, { detail: 'Device not found' });
        }
      }
      return jsonResponse(200, []);
    },
  });

  const wsClient = new TelemetryWebSocketClient({
    wsBaseUrl: 'ws://localhost:8000',
    tokenStore,
    wsFactory: (url, protocols) => new MockWebSocket(url, protocols),
  });

  const store = new DashboardStore(tokenStore, apiClient, wsClient);

  // 4.1: Gửi lệnh BẬT quạt -> nhận HTTP 202
  const res202 = await store.sendControlCommand('stm32-01', 'fan', 'turn_on');
  assert.deepEqual(lastControlPayload, { action: 'turn_on', target: 'fan' });
  assert.equal(res202.httpStatus, 202);
  assert.equal(res202.dispatchStatus, 'queued_202');
  assert.equal(res202.desiredAction, 'turn_on');
  assert.equal(
    res202.confirmedHardwareState,
    'unknown',
    'HTTP 202 tuyệt đối không được coi là thiết bị vật lý đã xác nhận ON'
  );
  assert.match(res202.statusMessage, /Đang chờ xác nhận/);
  store.applyRealtimeTelemetry({
    device_id: 'stm32-01',
    gateway_id: 'pi-gateway-01',
    timestamp: new Date().toISOString(),
    values: {},
    actuators: { fan: true },
  });
  assert.equal(
    store.getState().controlStates[makeControlKey('stm32-01', 'fan')]?.dispatchStatus,
    'confirmed'
  );
  assert.equal(
    store.getState().controlStates[makeControlKey('stm32-01', 'fan')]?.confirmedHardwareState,
    'on'
  );

  // 4.2: Gửi lệnh BẬT đèn -> gặp lỗi MQTT 503
  mockStatusToReturn = 503;
  const res503 = await store.sendControlCommand('stm32-01', 'light', 'turn_on');
  assert.equal(res503.httpStatus, 503);
  assert.equal(res503.dispatchStatus, 'error_503');
  assert.equal(res503.confirmedHardwareState, 'unknown');
  assert.match(res503.statusMessage, /503/);

  // 4.3: Gửi lệnh tới thiết bị chưa có trong DB -> gặp lỗi 404
  mockStatusToReturn = 404;
  const res404 = await store.sendControlCommand('stm32-01', 'fan', 'turn_off');
  assert.equal(res404.httpStatus, 404);
  assert.equal(res404.dispatchStatus, 'error_404');
  assert.equal(
    res404.confirmedHardwareState,
    'on',
    'Lệnh thất bại không được xóa trạng thái phần cứng đọc được trước đó'
  );
  assert.equal(
    store.getState().controlStates[makeControlKey('stm32-01', 'fan')]?.dispatchStatus,
    'error_404'
  );
});

test('5. Luồng Xử lý 401: tự động refresh tối đa 1 lần (single-flight) và yêu cầu đăng nhập lại nếu refresh thất bại', async () => {
  const tokenStore = new TokenStore(new MemoryStorage());
  tokenStore.setTokens({
    access_token: 'expired-access-token',
    refresh_token: 'valid-refresh-token',
    token_type: 'bearer',
  });

  let refreshCallCount = 0;
  let devicesCallCount = 0;
  let expiredCallbackReason: string | null = null;

  // Trường hợp A: Refresh thành công -> tự động gọi lại request với token mới
  const apiClientSuccess = new SmartHomeApiClient({
    baseUrl: 'http://localhost:8000',
    tokenStore,
    onSessionExpired: (reason) => {
      expiredCallbackReason = reason;
    },
    fetchImpl: async (input, init) => {
      const url = String(input);
      const authHeader = new Headers(init?.headers || {}).get('Authorization');

      if (url.endsWith('/api/v1/auth/refresh')) {
        refreshCallCount += 1;
        return jsonResponse(200, {
          access_token: 'fresh-access-token-999',
          refresh_token: 'fresh-refresh-token-999',
          token_type: 'bearer',
        });
      }

      if (url.endsWith('/api/v1/devices')) {
        devicesCallCount += 1;
        if (authHeader === 'Bearer expired-access-token') {
          return jsonResponse(401, { detail: 'Token expired' });
        }
        if (authHeader === 'Bearer fresh-access-token-999') {
          return jsonResponse(200, [
            {
              id: 'stm32-01',
              gateway_id: 'pi-gateway-01',
              name: 'Living Room Node',
              kind: 'stm32',
              is_online: true,
              last_seen_at: '2026-10-14T03:00:00Z',
            },
          ]);
        }
      }
      return jsonResponse(401, { detail: 'Unauthorized' });
    },
  });

  const devices = await apiClientSuccess.getDevices();
  assert.equal(refreshCallCount, 1, 'Chỉ gọi endpoint refresh đúng 1 lần');
  assert.equal(devicesCallCount, 2, 'Gọi lần 1 bị 401, gọi lại lần 2 thành công sau khi refresh');
  assert.equal(devices.length, 1);
  assert.equal(tokenStore.getAccessToken(), 'fresh-access-token-999');
  assert.equal(expiredCallbackReason, null);

  // Trường hợp B: Refresh thất bại -> xóa token và kích hoạt onSessionExpired
  let failRefreshCalls = 0;
  const apiClientFail = new SmartHomeApiClient({
    baseUrl: 'http://localhost:8000',
    tokenStore,
    onSessionExpired: (reason) => {
      expiredCallbackReason = reason;
    },
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith('/api/v1/auth/refresh')) {
        failRefreshCalls += 1;
        return jsonResponse(401, { detail: 'Refresh token expired' });
      }
      return jsonResponse(401, { detail: 'Access token expired' });
    },
  });

  await assert.rejects(
    async () => {
      await apiClientFail.getDevices();
    },
    (err: unknown) => err instanceof ApiError && err.status === 401
  );

  assert.equal(failRefreshCalls, 1, 'Chỉ thử refresh tối đa 1 lần trước khi yêu cầu đăng nhập lại');
  assert.equal(tokenStore.hasTokens(), false, 'Phải xóa toàn bộ token khi refresh thất bại');
  assert.match(String(expiredCallbackReason), /hết hạn/);
});

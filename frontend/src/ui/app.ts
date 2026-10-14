import {
  ActiveTab,
  DashboardState,
  DashboardStore,
  createInitialControlState,
  makeControlKey,
  makeSensorKey,
} from '../state/dashboardStore';
import {
  ControlAction,
  ControlTarget,
  DeviceItem,
  HistoryInterval,
  SensorReading,
  SensorType,
} from '../types/api';
import { getAppConfig, setRuntimeApiBaseUrl, deriveWsBaseUrl } from '../config/env';
import { SmartHomeApiClient } from '../services/apiClient';
import { TelemetryWebSocketClient } from '../services/wsClient';

function escapeHtml(raw: unknown): string {
  const str = String(raw ?? '');
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return 'Chưa ghi nhận';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('vi-VN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return 'Chưa có dữ liệu';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const diffSec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
    if (diffSec < 5) return 'Vừa xong';
    if (diffSec < 60) return `${diffSec} giây trước`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin} phút trước`;
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return `${diffHour} giờ trước`;
    return formatDateTime(iso);
  } catch {
    return iso;
  }
}

function renderNocturneBackdropSvg(): string {
  return `
    <div class="hero-backdrop-art" aria-hidden="true">
      <svg viewBox="0 0 1440 490" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice">
        <defs>
          <radialGradient id="skyGlow" cx="55%" cy="28%" r="60%">
            <stop offset="0%" stop-color="#2e3b4e" stop-opacity="0.65" />
            <stop offset="55%" stop-color="#181c24" stop-opacity="0.4" />
            <stop offset="100%" stop-color="#0f1115" stop-opacity="0" />
          </radialGradient>
          <linearGradient id="bladeGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#9ca3af" stop-opacity="0.42" />
            <stop offset="100%" stop-color="#374151" stop-opacity="0.08" />
          </linearGradient>
          <linearGradient id="solarPanel" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#2a3441" stop-opacity="0.55" />
            <stop offset="100%" stop-color="#14181f" stop-opacity="0.8" />
          </linearGradient>
        </defs>
        <rect width="1440" height="490" fill="url(#skyGlow)" />
        <!-- Isometric Smart Home Solar & Wind Telemetry Silhouette matching Nocturne video -->
        <g opacity="0.72">
          <!-- Turbine 1 -->
          <line x1="485" y1="118" x2="485" y2="410" stroke="#4b5563" stroke-width="5" stroke-opacity="0.45" />
          <circle cx="485" cy="118" r="5" fill="#9ca3af" fill-opacity="0.6" />
          <path d="M485 118 L518 42 L524 46 L489 119 Z" fill="url(#bladeGrad)" />
          <path d="M485 118 L412 146 L410 139 L483 114 Z" fill="url(#bladeGrad)" />
          <path d="M485 118 L538 176 L532 181 L482 121 Z" fill="url(#bladeGrad)" />

          <!-- Turbine 2 (Center) -->
          <line x1="665" y1="138" x2="665" y2="430" stroke="#4b5563" stroke-width="6" stroke-opacity="0.5" />
          <circle cx="665" cy="138" r="6" fill="#d1d5db" fill-opacity="0.65" />
          <path d="M665 138 L592 62 L598 56 L669 135 Z" fill="url(#bladeGrad)" />
          <path d="M665 138 L748 96 L752 103 L667 142 Z" fill="url(#bladeGrad)" />
          <path d="M665 138 L645 228 L637 226 L661 138 Z" fill="url(#bladeGrad)" />

          <!-- Turbine 3 (Right) -->
          <line x1="910" y1="95" x2="910" y2="415" stroke="#4b5563" stroke-width="7" stroke-opacity="0.45" />
          <circle cx="910" cy="95" r="6" fill="#9ca3af" fill-opacity="0.55" />
          <path d="M910 95 L985 38 L990 45 L913 99 Z" fill="url(#bladeGrad)" />
          <path d="M910 95 L830 70 L833 62 L911 91 Z" fill="url(#bladeGrad)" />
          <path d="M910 95 L918 190 L910 190 L906 95 Z" fill="url(#bladeGrad)" />

          <!-- Smart Home Control Hub & Solar Roof Grid -->
          <polygon points="340,420 580,330 850,395 610,485" fill="url(#solarPanel)" stroke="#374151" stroke-opacity="0.35" />
          <polygon points="880,350 1120,275 1310,335 1070,415" fill="url(#solarPanel)" stroke="#374151" stroke-opacity="0.4" />
          <circle cx="1040" cy="340" r="3" fill="#e07a3c" fill-opacity="0.8" />
          <circle cx="980" cy="360" r="2.5" fill="#5b9bd5" fill-opacity="0.8" />
        </g>
      </svg>
    </div>
  `;
}

export class SmartHomeDashboardApp {
  private readonly root: HTMLElement;
  private readonly store: DashboardStore;
  private readonly apiClient: SmartHomeApiClient;
  private readonly wsClient: TelemetryWebSocketClient;
  private clockTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    root: HTMLElement,
    store: DashboardStore,
    apiClient: SmartHomeApiClient,
    wsClient: TelemetryWebSocketClient
  ) {
    this.root = root;
    this.store = store;
    this.apiClient = apiClient;
    this.wsClient = wsClient;
  }

  public mount(): void {
    this.store.subscribe((state) => {
      this.render(state);
    });

    this.render(this.store.getState());

    if (this.store.getState().isAuthenticated && this.store.getState().mode === 'live') {
      void this.store.bootstrapLiveDashboard();
    }

    this.clockTimer = setInterval(() => {
      const clockEl = this.root.querySelector('#nocturne-live-clock');
      if (clockEl) {
        const now = new Date();
        clockEl.textContent = now.toLocaleTimeString('vi-VN', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
      }
    }, 1000);
  }

  public unmount(): void {
    if (this.clockTimer) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
  }

  private getAggregatedLatestSensor(
    state: DashboardState,
    sensorType: SensorType
  ): SensorReading | null {
    const selectedDevice = state.selectedDeviceId;
    if (selectedDevice !== 'all') {
      return state.latestSensorsByDevice[makeSensorKey(selectedDevice, sensorType)] || null;
    }

    let newest: SensorReading | null = null;
    for (const reading of Object.values(state.latestSensorsByDevice)) {
      if (reading.sensor_type !== sensorType) continue;
      if (!newest || new Date(reading.time).getTime() >= new Date(newest.time).getTime()) {
        newest = reading;
      }
    }
    return newest;
  }

  private render(state: DashboardState): void {
    if (!state.isAuthenticated) {
      this.renderLoginView(state);
    } else {
      this.renderDashboardView(state);
    }
  }

  private renderLoginView(state: DashboardState): void {
    const config = getAppConfig();
    this.root.innerHTML = `
      <div class="login-viewport">
        ${renderNocturneBackdropSvg()}
        <div class="login-card">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;">
            <span class="brand-name">Nocturne</span>
            <span class="mode-indicator-tag live">FastAPI Smart Home</span>
          </div>

          <div class="hero-overline">HỆ THỐNG GIÁM SÁT & ĐIỀU KHIỂN IOT</div>
          <h1 style="font-size:26px;font-weight:600;margin-bottom:6px;letter-spacing:-0.02em;">
            Đăng nhập Trạm Điều Khiển
          </h1>
          <p style="color:var(--text-secondary);font-size:13px;margin-bottom:20px;">
            Xác thực qua <code>POST /api/v1/auth/login</code> để nhận dữ liệu cảm biến và điều khiển thiết bị qua MQTT/WebSocket.
          </p>

          ${
            state.sessionExpiredNotice
              ? `<div class="status-alert-bar warning" role="alert">
                   <span>${escapeHtml(state.sessionExpiredNotice)}</span>
                 </div>`
              : ''
          }

          ${
            state.authError
              ? `<div class="status-alert-bar" role="alert">
                   <span>${escapeHtml(state.authError)}</span>
                 </div>`
              : ''
          }

          <form id="login-form" novalidate>
            <div class="form-group">
              <label class="form-label" for="api-base-url-input">
                Backend API Base URL (<code>VITE_API_BASE_URL</code>)
              </label>
              <input
                id="api-base-url-input"
                class="form-input"
                type="url"
                value="${escapeHtml(config.apiBaseUrl)}"
                placeholder="http://localhost:8000"
                required
              />
            </div>

            <div class="form-group">
              <label class="form-label" for="login-email-input">
                Email đăng nhập (gửi qua trường <code>username</code>)
              </label>
              <input
                id="login-email-input"
                class="form-input"
                type="email"
                autocomplete="username"
                placeholder="admin@example.com"
                required
              />
            </div>

            <div class="form-group">
              <label class="form-label" for="login-password-input">
                Mật khẩu (<code>password</code>)
              </label>
              <input
                id="login-password-input"
                class="form-input"
                type="password"
                autocomplete="current-password"
                placeholder="••••••••"
                required
              />
            </div>

            <button
              type="submit"
              class="btn-pill primary"
              style="width:100%;justify-content:center;padding:10px 16px;font-size:13.5px;margin-top:4px;"
              ${state.authLoading ? 'disabled' : ''}
            >
              ${state.authLoading ? 'Đang xác thực với Backend...' : 'Đăng nhập chế độ API Thật'}
            </button>
          </form>

          <div style="margin-top:22px;padding-top:18px;border-top:1px solid var(--border-subtle);">
            <div style="font-size:12px;color:var(--text-secondary);margin-bottom:10px;">
              Chưa bật FastAPI server tại <code>localhost:8000</code>? Bạn có thể mở chế độ xem thử giao diện với dữ liệu mô phỏng tách biệt hoàn toàn:
            </div>
            <button
              type="button"
              id="enter-simulation-btn"
              class="btn-pill turn-off"
              style="width:100%;justify-content:center;padding:9px 14px;"
            >
              Mở chế độ “Dữ liệu mô phỏng” (Demo Sandbox)
            </button>
          </div>
        </div>
      </div>
    `;

    const form = this.root.querySelector('#login-form') as HTMLFormElement | null;
    form?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const urlInput = this.root.querySelector('#api-base-url-input') as HTMLInputElement | null;
      const emailInput = this.root.querySelector('#login-email-input') as HTMLInputElement | null;
      const passInput = this.root.querySelector('#login-password-input') as HTMLInputElement | null;

      if (urlInput && urlInput.value.trim()) {
        const updated = setRuntimeApiBaseUrl(urlInput.value.trim());
        this.apiClient.setBaseUrl(updated.apiBaseUrl);
        this.wsClient.setWsBaseUrl(deriveWsBaseUrl(updated.apiBaseUrl));
      }

      const email = emailInput?.value || '';
      const password = passInput?.value || '';
      void this.store.loginLive(email, password);
    });

    const simBtn = this.root.querySelector('#enter-simulation-btn');
    simBtn?.addEventListener('click', () => {
      this.store.enterSimulationMode();
    });
  }

  private renderDashboardView(state: DashboardState): void {
    const config = getAppConfig();
    const isSim = state.mode === 'simulation';
    const onlineCount = state.devices.filter((d) => d.is_online).length;
    const totalDevices = state.devices.length;
    const onlinePercent = totalDevices > 0 ? Math.round((onlineCount / totalDevices) * 100) : 0;

    const nowTimeStr = new Date().toLocaleTimeString('vi-VN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    const wsStatusLabel =
      state.wsStatus === 'connected'
        ? 'Realtime WS: Đã kết nối'
        : state.wsStatus === 'connecting'
        ? 'Realtime WS: Đang kết nối...'
        : state.wsStatus === 'reconnecting'
        ? `WS Mất kết nối · Thử lại lần ${state.wsMeta.reconnectAttempt}`
        : state.wsStatus === 'auth_failed'
        ? 'WS Từ chối xác thực'
        : 'Realtime WS: Ngắt kết nối';

    const wsDotClass =
      state.wsStatus === 'connected'
        ? ''
        : state.wsStatus === 'reconnecting' || state.wsStatus === 'connecting'
        ? 'warn'
        : 'off';

    this.root.innerHTML = `
      ${isSim ? this.renderSimulationTopBanner(state) : ''}
      <div class="nocturne-shell">
        ${renderNocturneBackdropSvg()}

        <!-- Top Navigation Header -->
        <header class="top-header">
          <div class="brand-cluster">
            <span class="brand-name">Nocturne</span>
            <span class="mode-indicator-tag ${isSim ? 'sim' : 'live'}">
              ${
                isSim
                  ? '● DỮ LIỆU MÔ PHỎNG (DEMO)'
                  : `● API THẬT (${escapeHtml(config.apiBaseUrl)})`
              }
            </span>
          </div>

          <nav class="nav-capsule" aria-label="Điều hướng chính">
            <button
              type="button"
              class="nav-pill-btn ${state.activeTab === 'overview' ? 'active' : ''}"
              data-tab="overview"
            >
              Night shift · Tổng quan
            </button>
            <button
              type="button"
              class="nav-pill-btn ${state.activeTab === 'devices' ? 'active' : ''}"
              data-tab="devices"
            >
              Thiết bị &amp; Điều khiển
              <span class="nav-badge-count">${totalDevices}</span>
            </button>
            <button
              type="button"
              class="nav-pill-btn ${state.activeTab === 'history' ? 'active' : ''}"
              data-tab="history"
            >
              Lịch sử đo
            </button>
            <button
              type="button"
              class="nav-pill-btn ${state.activeTab === 'alerts' ? 'active' : ''}"
              data-tab="alerts"
            >
              Cảnh báo
              <span class="nav-badge-count">${state.alerts.length}</span>
            </button>
          </nav>

          <div class="header-right">
            <div class="clock-widget">
              <div>
                <div id="nocturne-live-clock" class="clock-time">${escapeHtml(nowTimeStr)}</div>
                <div class="clock-sub">${escapeHtml(wsStatusLabel)}</div>
              </div>
            </div>

            <div class="user-pill">
              <div class="user-avatar">
                ${escapeHtml((state.user?.email || 'U').slice(0, 1).toUpperCase())}
                <span class="user-avatar-dot ${wsDotClass}"></span>
              </div>
              <div class="user-meta">
                <span class="user-name">${escapeHtml(state.user?.email || 'operator')}</span>
                <span class="user-role">${isSim ? 'Dữ liệu mô phỏng' : `${onlineCount}/${totalDevices} thiết bị online`}</span>
              </div>
              <button
                type="button"
                id="logout-btn"
                class="btn-pill danger"
                style="padding:4px 11px;font-size:11.5px;margin-left:4px;"
                title="Xóa token, đóng WebSocket và quay về trang đăng nhập"
              >
                Đăng xuất
              </button>
            </div>
          </div>
        </header>

        ${this.renderConnectionBanners(state)}

        ${
          state.activeTab === 'overview'
            ? this.renderOverviewTab(state, onlineCount, totalDevices, onlinePercent)
            : state.activeTab === 'devices'
            ? this.renderDevicesAndControlTab(state)
            : state.activeTab === 'history'
            ? this.renderHistoryTab(state)
            : this.renderAlertsTab(state)
        }
      </div>
    `;

    this.bindDashboardEvents(state);
  }

  private renderSimulationTopBanner(state: DashboardState): string {
    return `
      <div class="simulation-banner" role="region" aria-label="Thanh thông báo dữ liệu mô phỏng">
        <div class="simulation-banner-left">
          <span class="simulation-badge-pill">Dữ liệu mô phỏng</span>
          <span>
            Bạn đang xem chế độ <strong>Dữ liệu mô phỏng (Demo Sandbox)</strong> — tách biệt hoàn toàn với chế độ API thật. Mọi số đo và phản hồi điều khiển hiện tại là dữ liệu giả lập.
          </span>
        </div>
        <div class="simulation-controls">
          <button type="button" class="btn-pill" id="sim-push-telemetry-btn" style="padding:4px 10px;font-size:11px;">
            + Phát gói WS Telemetry
          </button>
          <button type="button" class="btn-pill" id="sim-push-alert-btn" style="padding:4px 10px;font-size:11px;">
            + Phát WS Cảnh báo
          </button>
          <select id="sim-fault-select" class="form-select" style="width:auto;padding:3px 10px;font-size:11.5px;height:28px;">
            <option value="none" ${state.simulationFaultMode === 'none' ? 'selected' : ''}>
              Kịch bản lệnh: Bình thường (HTTP 202)
            </option>
            <option value="mqtt_503" ${state.simulationFaultMode === 'mqtt_503' ? 'selected' : ''}>
              Giả lập lỗi MQTT mất kết nối (HTTP 503)
            </option>
            <option value="device_404" ${state.simulationFaultMode === 'device_404' ? 'selected' : ''}>
              Giả lập lỗi thiếu thiết bị DB (HTTP 404)
            </option>
            <option value="empty_devices" ${state.simulationFaultMode === 'empty_devices' ? 'selected' : ''}>
              Giả lập danh sách thiết bị rỗng ([])
            </option>
          </select>
          <button type="button" class="btn-pill primary" id="exit-simulation-btn" style="padding:4px 11px;font-size:11px;">
            Thoát mô phỏng / Về trang Login API Thật
          </button>
        </div>
      </div>
    `;
  }

  private renderConnectionBanners(state: DashboardState): string {
    const banners: string[] = [];

    if (state.dashboardError) {
      banners.push(`
        <div class="status-alert-bar" role="alert">
          <div>
            <strong>Lỗi giao tiếp API:</strong> ${escapeHtml(state.dashboardError)}
          </div>
          <button type="button" class="btn-pill" id="retry-bootstrap-btn">
            Thử tải lại dữ liệu
          </button>
        </div>
      `);
    }

    if (
      state.mode === 'live' &&
      (state.wsStatus === 'reconnecting' || state.wsStatus === 'disconnected' || state.wsStatus === 'auth_failed') &&
      !state.initialLoading
    ) {
      const reason =
        state.wsMeta.disconnectReason ||
        'Kết nối WebSocket realtime hiện đang gián đoạn.';
      const retryNote =
        state.wsMeta.nextRetryDelayMs !== null
          ? ` (Tự động kết nối lại sau ${Math.round(state.wsMeta.nextRetryDelayMs / 1000)}s - lần thử #${state.wsMeta.reconnectAttempt})`
          : '';
      banners.push(`
        <div class="status-alert-bar warning" role="status">
          <div>
            <strong>Trạng thái WebSocket:</strong> ${escapeHtml(reason)}${escapeHtml(retryNote)}
          </div>
          <button type="button" class="btn-pill" id="retry-ws-now-btn">
            Kết nối lại WebSocket ngay
          </button>
        </div>
      `);
    }

    return banners.join('');
  }

  private renderOverviewTab(
    state: DashboardState,
    onlineCount: number,
    totalDevices: number,
    onlinePercent: number
  ): string {
    const isSim = state.mode === 'simulation';
    const tempReading = this.getAggregatedLatestSensor(state, 'temperature');
    const humReading = this.getAggregatedLatestSensor(state, 'humidity');
    const lightReading = this.getAggregatedLatestSensor(state, 'light');
    const motionReading = this.getAggregatedLatestSensor(state, 'motion');

    const strokeDasharray = `${Math.round((onlinePercent / 100) * 113)} 113`;

    return `
      <!-- Hero Section (Nocturne Night Shift Style) -->
      <section class="hero-section">
        <div class="hero-top-row">
          <div class="hero-title-block">
            <div class="hero-overline">
              ${isSim ? 'CHẾ ĐỘ DỮ LIỆU MÔ PHỎNG · TELEMETRY WINDOW' : 'TELEMETRY & MQTT CONTROL WINDOW'}
            </div>
            <div class="hero-main-title">
              <span>Night shift</span>
              ${this.renderDeviceFilterSelect(state)}
            </div>
            <p class="hero-subtitle">
              Giám sát số đo cảm biến thời gian thực qua WebSocket và điều khiển thiết bị chấp hành qua MQTT Broker.
            </p>
            <div class="hero-legend-row">
              <span class="legend-item"><span class="legend-dot" style="background:#5b9bd5;"></span> Nhiệt độ (°C)</span>
              <span class="legend-item"><span class="legend-dot" style="background:#4eba83;"></span> Độ ẩm (%)</span>
              <span class="legend-item"><span class="legend-dot" style="background:#e07a3c;"></span> Ánh sáng (lx)</span>
              <span class="legend-item"><span class="legend-dot" style="background:#dfc15d;"></span> Chuyển động (PIR)</span>
            </div>
          </div>

          <div class="hero-status-card">
            <div class="radial-gauge">
              <svg width="48" height="48" viewBox="0 0 44 44">
                <circle cx="22" cy="22" r="18" stroke="rgba(255,255,255,0.1)" stroke-width="3.5" fill="none" />
                <circle
                  cx="22"
                  cy="22"
                  r="18"
                  stroke="${onlineCount > 0 ? '#e07a3c' : '#6b7280'}"
                  stroke-width="3.5"
                  stroke-dasharray="${strokeDasharray}"
                  stroke-linecap="round"
                  fill="none"
                  transform="rotate(-90 22 22)"
                />
              </svg>
              <div class="radial-gauge-label">${onlineCount}/${totalDevices}</div>
            </div>
            <div class="hero-status-info">
              <div class="hero-status-label">Trạng thái kết nối thiết bị</div>
              <div class="hero-status-headline">
                ${
                  totalDevices === 0
                    ? 'Chưa có thiết bị'
                    : `${onlineCount} Online · ${totalDevices - onlineCount} Offline`
                }
              </div>
              <div class="hero-status-sub">
                Ping WS: ${state.wsMeta.lastPingSentAt ? formatRelativeTime(state.wsMeta.lastPingSentAt) : 'Chờ kết nối'}
              </div>
            </div>
            <span class="status-pill ${state.wsStatus === 'connected' ? 'amber' : 'muted'}">
              ● ${state.wsStatus === 'connected' ? (isSim ? 'Mô phỏng' : 'Live') : 'Offline'}
            </span>
          </div>
        </div>

        ${this.renderHeroBarChart(state, tempReading, humReading, lightReading, motionReading)}
      </section>

      <!-- Middle Row: 4 Sensor KPI Cards (Read-only measurements, never control switches) -->
      <section class="sensor-kpi-grid" aria-label="Số đo cảm biến mới nhất">
        ${this.renderSensorCards(tempReading, humReading, lightReading, motionReading)}
      </section>

      <!-- Bottom Split Grid: Left = Devices & Sensor Matrix | Right = Fan/Light Control & Alerts Preview -->
      <section class="bottom-split-grid">
        ${this.renderLeftDevicesPanel(state)}
        ${this.renderRightControlPanel(state)}
      </section>
    `;
  }

  private renderDeviceFilterSelect(state: DashboardState): string {
    return `
      <select
        id="device-filter-select"
        class="form-select"
        style="width:auto;min-width:210px;padding:6px 12px;font-size:12.5px;border-radius:999px;background:rgba(28,31,38,0.85);"
        aria-label="Lọc theo thiết bị"
      >
        <option value="all" ${state.selectedDeviceId === 'all' ? 'selected' : ''}>
          Tất cả thiết bị (${state.devices.length})
        </option>
        ${state.devices
          .map(
            (d) => `
          <option value="${escapeHtml(d.id)}" ${state.selectedDeviceId === d.id ? 'selected' : ''}>
            ${escapeHtml(d.name || d.id)} (${escapeHtml(d.id)}) · ${d.is_online ? 'Online' : 'Offline'}
          </option>
        `
          )
          .join('')}
      </select>
    `;
  }

  private renderHeroBarChart(
    state: DashboardState,
    tempReading: SensorReading | null,
    humReading: SensorReading | null,
    lightReading: SensorReading | null,
    motionReading: SensorReading | null
  ): string {
    const timeline = state.realtimeTimeline;
    const latestDevice =
      tempReading?.device_id ||
      humReading?.device_id ||
      lightReading?.device_id ||
      state.devices[0]?.id ||
      'Chưa có';

    const barsCount = 16;
    const padded = Array.from({ length: barsCount }, (_, idx) => {
      const offset = timeline.length - barsCount + idx;
      return offset >= 0 ? timeline[offset] : null;
    });

    return `
      <div class="hero-chart-wrapper">
        <div class="hero-chart-header">
          <div class="now-callout-row">
            <span class="now-pill">now</span>
            <div class="telemetry-summary-pill">
              <span>Thiết bị: <strong>${escapeHtml(latestDevice)}</strong></span>
              <span>|</span>
              <span>Nhiệt độ: <strong>${tempReading ? `${tempReading.value}°C` : '--'}</strong></span>
              <span>|</span>
              <span>Độ ẩm: <strong>${humReading ? `${humReading.value}%` : '--'}</strong></span>
              <span>|</span>
              <span>Ánh sáng: <strong>${lightReading ? `${lightReading.value} lx` : '--'}</strong></span>
              <span>|</span>
              <span>Chuyển động: <strong>${
                motionReading ? (motionReading.value > 0 ? 'Phát hiện (1)' : 'Không (0)') : '--'
              }</strong></span>
            </div>
          </div>

          <div style="display:flex;align-items:center;gap:8px;">
            <button type="button" class="btn-pill" id="refresh-all-btn" style="padding:4px 12px;font-size:11.5px;">
              ↻ Đồng bộ lại API
            </button>
          </div>
        </div>

        <div class="bars-stage">
          ${padded
            .map((pt, i) => {
              if (!pt) {
                return `
                  <div class="bar-col">
                    <div class="bar-cap" style="opacity:0.2;"></div>
                    <div class="bar-body slate" style="height:16%;"></div>
                  </div>
                `;
              }
              const tempVal = typeof pt.temperature === 'number' ? pt.temperature : 24;
              const lightVal = typeof pt.light === 'number' ? pt.light : 100;
              const heightPct = Math.min(96, Math.max(20, Math.round((tempVal / 40) * 75 + (lightVal / 1000) * 25)));
              const colorClass =
                pt.motion && pt.motion > 0
                  ? 'amber'
                  : i >= barsCount - 5
                  ? 'amber'
                  : 'blue';

              return `
                <div class="bar-col" title="${escapeHtml(`${pt.label} · ${pt.device_id} · Nhiệt độ: ${pt.temperature ?? '--'}°C · Độ ẩm: ${pt.humidity ?? '--'}%`)}">
                  <div class="bar-cap"></div>
                  <div class="bar-body ${colorClass}" style="height:${heightPct}%;"></div>
                </div>
              `;
            })
            .join('')}
        </div>

        <div class="bar-time-axis">
          <span>${escapeHtml(padded[0]?.label || 'Khởi tạo')}</span>
          <span>${escapeHtml(padded[5]?.label || '--:--')}</span>
          <span>${escapeHtml(padded[10]?.label || '--:--')}</span>
          <span>Hiện tại (${escapeHtml(padded[barsCount - 1]?.label || 'Realtime')})</span>
        </div>
      </div>
    `;
  }

  private renderSensorCards(
    temp: SensorReading | null,
    hum: SensorReading | null,
    light: SensorReading | null,
    motion: SensorReading | null
  ): string {
    const tempVal = temp ? temp.value : null;
    const tempPct = tempVal !== null ? Math.min(100, Math.max(8, Math.round((tempVal / 50) * 100))) : 0;

    const humVal = hum ? hum.value : null;
    const humPct = humVal !== null ? Math.min(100, Math.max(8, Math.round(humVal))) : 0;

    const lightVal = light ? light.value : null;
    const lightPct = lightVal !== null ? Math.min(100, Math.max(8, Math.round((lightVal / 1000) * 100))) : 0;

    const motionVal = motion ? motion.value : null;
    const motionDetected = motionVal !== null && motionVal > 0;

    return `
      <!-- Card 1: Temperature -->
      <article class="sensor-card glow-blue">
        <div class="sensor-card-top">
          <span class="sensor-title">Cảm biến Nhiệt độ (temperature)</span>
          <span class="status-pill ${tempVal !== null && tempVal > 32 ? 'amber' : 'blue'}">
            ● ${tempVal === null ? 'Chưa có số đo' : tempVal > 32 ? 'Nhiệt độ cao' : 'Chỉ đọc (Số đo)'}
          </span>
        </div>
        <div class="sensor-card-mid">
          <div class="sensor-value-wrap">
            <span class="sensor-value-num">${tempVal !== null ? escapeHtml(tempVal) : '--'}</span>
            <span class="sensor-value-unit">°C</span>
          </div>
          <div class="sensor-progress-track">
            <div class="sensor-progress-fill blue" style="width:${tempPct}%;">
              ${tempVal !== null ? '<span class="sensor-progress-thumb"></span>' : ''}
            </div>
          </div>
        </div>
        <div class="sensor-card-foot">
          <span>Node: ${escapeHtml(temp?.device_id || 'Chưa có')}</span>
          <span>${temp ? escapeHtml(formatRelativeTime(temp.time)) : 'Đợi telemetry'}</span>
        </div>
      </article>

      <!-- Card 2: Humidity -->
      <article class="sensor-card glow-green">
        <div class="sensor-card-top">
          <span class="sensor-title">Cảm biến Độ ẩm (humidity)</span>
          <span class="status-pill green">
            ● ${humVal === null ? 'Chưa có số đo' : 'Chỉ đọc (Số đo)'}
          </span>
        </div>
        <div class="sensor-card-mid">
          <div class="sensor-value-wrap">
            <span class="sensor-value-num">${humVal !== null ? escapeHtml(humVal) : '--'}</span>
            <span class="sensor-value-unit">%</span>
          </div>
          <div class="sensor-progress-track">
            <div class="sensor-progress-fill green" style="width:${humPct}%;">
              ${humVal !== null ? '<span class="sensor-progress-thumb"></span>' : ''}
            </div>
          </div>
        </div>
        <div class="sensor-card-foot">
          <span>Node: ${escapeHtml(hum?.device_id || 'Chưa có')}</span>
          <span>${hum ? escapeHtml(formatRelativeTime(hum.time)) : 'Đợi telemetry'}</span>
        </div>
      </article>

      <!-- Card 3: Light -->
      <article class="sensor-card glow-amber">
        <div class="sensor-card-top">
          <span class="sensor-title">Cường độ Ánh sáng (light)</span>
          <span class="status-pill amber">
            ● ${lightVal === null ? 'Chưa có số đo' : 'Chỉ đọc (Số đo)'}
          </span>
        </div>
        <div class="sensor-card-mid">
          <div class="sensor-value-wrap">
            <span class="sensor-value-num">${lightVal !== null ? escapeHtml(lightVal) : '--'}</span>
            <span class="sensor-value-unit">lx</span>
          </div>
          <div class="sensor-progress-track">
            <div class="sensor-progress-fill amber" style="width:${lightPct}%;">
              ${lightVal !== null ? '<span class="sensor-progress-thumb"></span>' : ''}
            </div>
          </div>
        </div>
        <div class="sensor-card-foot">
          <span>Node: ${escapeHtml(light?.device_id || 'Chưa có')}</span>
          <span>${light ? escapeHtml(formatRelativeTime(light.time)) : 'Đợi telemetry'}</span>
        </div>
      </article>

      <!-- Card 4: Motion -->
      <article class="sensor-card glow-gold">
        <div class="sensor-card-top">
          <span class="sensor-title">Cảm biến Chuyển động (motion)</span>
          <span class="status-pill ${motionDetected ? 'amber' : 'muted'}">
            ● ${motionVal === null ? 'Chưa có số đo' : motionDetected ? 'Có chuyển động' : 'Không chuyển động'}
          </span>
        </div>
        <div class="sensor-card-mid">
          <div class="sensor-value-wrap">
            <span class="sensor-value-num">${
              motionVal === null ? '--' : motionDetected ? 'Phát hiện' : 'Tĩnh'
            }</span>
            <span class="sensor-value-unit">${motionVal !== null ? `(${motionVal})` : ''}</span>
          </div>
          <svg width="110" height="36" viewBox="0 0 110 36" fill="none" aria-hidden="true">
            <path
              d="M2 28 L18 26 L34 ${motionDetected ? '8' : '25'} L50 24 L66 ${
      motionDetected ? '10' : '22'
    } L84 18 L106 ${motionDetected ? '6' : '20'}"
              stroke="#e07a3c"
              stroke-width="2"
              stroke-linecap="round"
            />
            <circle cx="106" cy="${motionDetected ? '6' : '20'}" r="3.5" fill="#fff" stroke="#e07a3c" stroke-width="2" />
          </svg>
        </div>
        <div class="sensor-card-foot">
          <span>Node: ${escapeHtml(motion?.device_id || 'Chưa có')}</span>
          <span>${motion ? escapeHtml(formatRelativeTime(motion.time)) : 'Chỉ đọc số đo PIR'}</span>
        </div>
      </article>
    `;
  }

  private renderLeftDevicesPanel(state: DashboardState): string {
    const devices = state.devices;
    const onlineCount = devices.filter((d) => d.is_online).length;

    // 48-cell visual sensor matrix matching Nocturne's "Cell temperature" panel aesthetic
    const cellsHtml = Array.from({ length: 48 }, (_, idx) => {
      if (devices.length === 0) {
        return `<div class="heatmap-cell inactive" title="Chưa có dữ liệu telemetry"></div>`;
      }
      const dev = devices[idx % devices.length];
      if (!dev.is_online) {
        return `<div class="heatmap-cell inactive" title="${escapeHtml(dev.id)}: Offline"></div>`;
      }
      const temp = state.latestSensorsByDevice[makeSensorKey(dev.id, 'temperature')]?.value ?? 25;
      const cls =
        temp >= 28 ? 'hot' : temp >= 25.5 ? 'warm' : temp >= 23 ? 'normal' : 'cool';
      return `<div class="heatmap-cell ${cls}" title="${escapeHtml(`${dev.id} · ${temp}°C`)}"></div>`;
    }).join('');

    return `
      <div class="glass-panel">
        <div>
          <div class="panel-header">
            <div>
              <h2 class="panel-title">Danh sách Thiết bị &amp; Ma trận Cảm biến</h2>
              <p class="panel-subtitle">
                Nguồn: <code>GET /api/v1/devices</code> &amp; cập nhật WebSocket · ${devices.length} thiết bị (${onlineCount} trực tuyến)
              </p>
            </div>
            <span class="status-pill ${onlineCount > 0 ? 'green' : 'muted'}">
              ● ${onlineCount} Online / ${devices.length} Tổng
            </span>
          </div>

          <div class="cell-heatmap-grid" aria-label="Ma trận trạng thái các điểm đo">
            ${cellsHtml}
          </div>

          ${
             state.initialLoading
              ? `<div class="empty-state-box">
                   <div class="empty-state-title">Đang tải danh sách thiết bị và cảm biến...</div>
                   <p class="empty-state-desc">Đang gọi <code>GET /api/v1/devices</code> và <code>GET /api/v1/sensors/latest</code>.</p>
                 </div>`
              : devices.length === 0
              ? `<div class="empty-state-box" data-testid="empty-devices-guidance">
                   <div class="empty-state-title">Chưa có thiết bị nào trong hệ thống</div>
                   <p class="empty-state-desc">
                     Backend hiện trả về danh sách thiết bị rỗng (<code>[]</code>). Theo cơ chế của hệ thống,
                     <strong>backend chỉ tự động tạo và hiển thị thiết bị sau khi nhận được gói tin telemetry đầu tiên</strong>
                     từ mạch cảm biến/gateway. Giao diện tuyệt đối không tự tạo thiết bị giả ở chế độ API thật.
                   </p>
                   <div style="display:flex;justify-content:center;gap:10px;flex-wrap:wrap;">
                     <button type="button" class="btn-pill primary" id="empty-reload-devices-btn">
                       Kiểm tra lại GET /api/v1/devices
                     </button>
                     ${
                       state.mode === 'live'
                         ? `<button type="button" class="btn-pill turn-off" id="empty-switch-sim-btn">
                              Xem thử bằng Chế độ Dữ liệu mô phỏng
                            </button>`
                         : ''
                     }
                   </div>
                 </div>`
              : `<div class="device-list-stack">
                   ${devices.map((dev) => this.renderDeviceRowCard(state, dev)).join('')}
                 </div>`
          }
        </div>

        <div class="panel-footnote-box">
          <span>
            Trạng thái <strong>Online / Offline</strong> hiển thị đúng theo trường <code>is_online</code> và <code>last_seen_at</code> từ API, không dùng để suy đoán trạng thái bật/tắt của quạt hay đèn.
          </span>
        </div>
      </div>
    `;
  }

  private renderDeviceRowCard(state: DashboardState, dev: DeviceItem): string {
    const t = state.latestSensorsByDevice[makeSensorKey(dev.id, 'temperature')];
    const h = state.latestSensorsByDevice[makeSensorKey(dev.id, 'humidity')];
    const l = state.latestSensorsByDevice[makeSensorKey(dev.id, 'light')];
    const m = state.latestSensorsByDevice[makeSensorKey(dev.id, 'motion')];

    return `
      <div class="device-row-card ${state.selectedDeviceId === dev.id ? 'selected' : ''}">
        <div class="device-primary-info">
          <div class="device-name-line">
            <span>${escapeHtml(dev.name || dev.id)}</span>
            <span class="status-pill ${dev.is_online ? 'green' : 'danger'}">
              ● ${dev.is_online ? 'Online' : 'Offline'}
            </span>
          </div>
          <div class="device-meta-line">
            ID: <strong>${escapeHtml(dev.id)}</strong> · Gateway: ${escapeHtml(dev.gateway_id || 'N/A')} · Loại: ${escapeHtml(dev.kind || 'node')} · Last seen: ${escapeHtml(formatDateTime(dev.last_seen_at))}
          </div>
        </div>

        <div class="device-metrics-inline">
          <span class="device-metric-chip" title="Nhiệt độ">🌡 ${t ? `${t.value}°C` : '--'}</span>
          <span class="device-metric-chip" title="Độ ẩm">💧 ${h ? `${h.value}%` : '--'}</span>
          <span class="device-metric-chip" title="Ánh sáng">☀ ${l ? `${l.value} lx` : '--'}</span>
          <span class="device-metric-chip" title="Chuyển động">🏃 ${
            m ? (m.value > 0 ? 'Có (1)' : 'Không (0)') : '--'
          }</span>
        </div>
      </div>
    `;
  }

  private renderRightControlPanel(state: DashboardState): string {
    const visibleDevices =
      state.selectedDeviceId === 'all'
        ? state.devices
        : state.devices.filter((d) => d.id === state.selectedDeviceId);

    const targets: { target: ControlTarget; label: string; icon: string }[] = [
      { target: 'fan', label: 'Quạt thông gió (fan)', icon: '🌀' },
      { target: 'light', label: 'Đèn chiếu sáng (light)', icon: '💡' },
    ];

    return `
      <div class="glass-panel">
        <div>
          <div class="panel-header">
            <div>
              <h2 class="panel-title">Điều khiển Quạt &amp; Đèn (MQTT Control)</h2>
              <p class="panel-subtitle">
                Endpoint: <code>POST /api/v1/devices/{device_id}/control</code> · Chỉ hỗ trợ target <code>fan</code> và <code>light</code>
              </p>
            </div>
            <span class="status-pill amber">Trạng thái lấy từ Modbus</span>
          </div>

          ${
            visibleDevices.length === 0
              ? `<div class="empty-state-box">
                   <div class="empty-state-title">Chưa có thiết bị để gửi lệnh điều khiển</div>
                   <p class="empty-state-desc">
                     Vui lòng chờ thiết bị gửi gói tin telemetry đầu tiên để xuất hiện trong danh sách trước khi gửi lệnh điều khiển quạt/đèn.
                   </p>
                 </div>`
              : `<div class="control-rows-list">
                   ${visibleDevices
                     .map((dev) =>
                       targets
                         .map((t) => this.renderSingleControlRow(state, dev, t.target, t.label, t.icon))
                         .join('')
                     )
                     .join('')}
                 </div>`
          }
        </div>

        <div class="panel-footnote-box">
          <span>
            <strong>Cách đồng bộ:</strong> Gateway đọc trạng thái cuộn Modbus định kỳ và gửi telemetry qua MQTT; dashboard cập nhật khi nhận dữ liệu. Mã <code>202 Accepted</code> chỉ xác nhận backend đã nhận lệnh, trạng thái thiết bị chỉ đổi sau khi có báo cáo thực tế.
          </span>
        </div>
      </div>
    `;
  }

  private renderSingleControlRow(
    state: DashboardState,
    dev: DeviceItem,
    target: ControlTarget,
    label: string,
    icon: string
  ): string {
    const cKey = makeControlKey(dev.id, target);
    const ctrl =
      state.controlStates[cKey] || createInitialControlState(dev.id, target);

    const desiredText =
      ctrl.desiredAction === 'turn_on'
        ? 'Muốn BẬT (turn_on)'
        : ctrl.desiredAction === 'turn_off'
        ? 'Muốn TẮT (turn_off)'
        : 'Chưa gửi lệnh';
    const confirmedText =
      ctrl.confirmedHardwareState === 'on'
        ? 'ĐANG BẬT (Modbus)'
        : ctrl.confirmedHardwareState === 'off'
          ? 'ĐANG TẮT (Modbus)'
          : 'Chưa rõ / Chưa có phản hồi';

    const dispatchBadge =
      ctrl.dispatchStatus === 'sending'
        ? '<span class="status-pill blue">Đang gửi lệnh...</span>'
        : ctrl.dispatchStatus === 'queued_202'
        ? '<span class="status-pill amber">Đã gửi lệnh / Đang chờ xác nhận (202)</span>'
        : ctrl.dispatchStatus === 'confirmed'
        ? '<span class="status-pill green">Gateway đã xác nhận</span>'
        : ctrl.dispatchStatus.startsWith('error')
        ? `<span class="status-pill danger">Gửi lệnh thất bại (${ctrl.httpStatus || 'Mạng'})</span>`
        : '<span class="status-pill muted">Sẵn sàng</span>';

    const isSending = ctrl.dispatchStatus === 'sending';
    const hasError = ctrl.dispatchStatus.startsWith('error');

    return `
      <div class="control-signal-row" data-testid="control-row-${escapeHtml(dev.id)}-${escapeHtml(target)}">
        <div class="control-row-header">
          <div class="control-target-title">
            <span>${icon} ${escapeHtml(label)}</span>
            <span class="control-target-id">${escapeHtml(dev.id)}</span>
          </div>
          ${dispatchBadge}
        </div>

        <div class="control-states-comparison">
          <div>
            <div class="state-box-label">1. Trạng thái lệnh mong muốn (Từ UI)</div>
            <div class="state-box-val ${
              ctrl.dispatchStatus === 'queued_202'
                ? 'pending'
                : hasError
                ? 'err'
                : ''
            }">
              ${escapeHtml(desiredText)}
            </div>
          </div>
          <div>
            <div class="state-box-label">2. Trạng thái thiết bị đã xác nhận (Phần cứng)</div>
            <div class="state-box-val ${
              ctrl.confirmedHardwareState === 'unknown' ? 'unknown' : ctrl.confirmedHardwareState === 'on' ? 'on' : 'off'
            }" data-testid="confirmed-state-${escapeHtml(dev.id)}-${escapeHtml(target)}">
              ${escapeHtml(confirmedText)}
            </div>
          </div>
        </div>

        <div class="control-actions-bar">
          <div class="control-status-msg ${hasError ? 'error' : ctrl.dispatchStatus === 'queued_202' ? 'queued' : ''}">
            ${escapeHtml(ctrl.statusMessage)}
          </div>
          <div class="control-btn-group">
            <button
              type="button"
              class="btn-pill turn-on ${ctrl.confirmedHardwareState === 'on' ? 'active-confirmed' : ctrl.desiredAction === 'turn_on' && ctrl.dispatchStatus === 'queued_202' ? 'active-desired' : ''}"
              data-control-device="${escapeHtml(dev.id)}"
              data-control-target="${escapeHtml(target)}"
              data-control-action="turn_on"
              ${isSending ? 'disabled' : ''}
            >
              Bật (turn_on)
            </button>
            <button
              type="button"
              class="btn-pill turn-off ${ctrl.confirmedHardwareState === 'off' ? 'active-confirmed' : ctrl.desiredAction === 'turn_off' && ctrl.dispatchStatus === 'queued_202' ? 'active-desired' : ''}"
              data-control-device="${escapeHtml(dev.id)}"
              data-control-target="${escapeHtml(target)}"
              data-control-action="turn_off"
              ${isSending ? 'disabled' : ''}
            >
              Tắt (turn_off)
            </button>
            ${
              hasError && ctrl.desiredAction
                ? `<button
                     type="button"
                     class="btn-pill primary"
                     data-control-device="${escapeHtml(dev.id)}"
                     data-control-target="${escapeHtml(target)}"
                     data-control-action="${escapeHtml(ctrl.desiredAction)}"
                   >
                     Thử lại
                   </button>`
                : ''
            }
          </div>
        </div>
      </div>
    `;
  }

  private renderDevicesAndControlTab(state: DashboardState): string {
    return `
      <div class="bottom-split-grid">
        ${this.renderLeftDevicesPanel(state)}
        ${this.renderRightControlPanel(state)}
      </div>
    `;
  }

  private renderHistoryTab(state: DashboardState): string {
    const { sensorType, interval, lookbackHours } = state.historyFilter;
    const points = state.historyPoints;

    return `
      <div class="glass-panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Lịch sử Cảm biến (<code>GET /api/v1/sensors/history</code>)</h2>
            <p class="panel-subtitle">
              Lưu ý: Tham số <code>interval</code> hỗ trợ <code>raw, 1m, 5m, 1h, 1d</code> nhưng backend hiện trả về các điểm <strong>raw points</strong> mà chưa tự gom nhóm (bucket).
            </p>
          </div>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <select id="history-type-select" class="form-select" style="width:auto;padding:6px 12px;">
              <option value="temperature" ${sensorType === 'temperature' ? 'selected' : ''}>Nhiệt độ (temperature)</option>
              <option value="humidity" ${sensorType === 'humidity' ? 'selected' : ''}>Độ ẩm (humidity)</option>
              <option value="light" ${sensorType === 'light' ? 'selected' : ''}>Ánh sáng (light)</option>
              <option value="motion" ${sensorType === 'motion' ? 'selected' : ''}>Chuyển động (motion)</option>
            </select>

            <select id="history-interval-select" class="form-select" style="width:auto;padding:6px 12px;">
              <option value="raw" ${interval === 'raw' ? 'selected' : ''}>Interval: raw</option>
              <option value="1m" ${interval === '1m' ? 'selected' : ''}>Interval: 1m (raw backend)</option>
              <option value="5m" ${interval === '5m' ? 'selected' : ''}>Interval: 5m (raw backend)</option>
              <option value="1h" ${interval === '1h' ? 'selected' : ''}>Interval: 1h (raw backend)</option>
              <option value="1d" ${interval === '1d' ? 'selected' : ''}>Interval: 1d (raw backend)</option>
            </select>

            <select id="history-hours-select" class="form-select" style="width:auto;padding:6px 12px;">
              <option value="1" ${lookbackHours === 1 ? 'selected' : ''}>1 giờ qua</option>
              <option value="6" ${lookbackHours === 6 ? 'selected' : ''}>6 giờ qua</option>
              <option value="24" ${lookbackHours === 24 ? 'selected' : ''}>24 giờ qua</option>
              <option value="168" ${lookbackHours === 168 ? 'selected' : ''}>7 ngày qua</option>
            </select>

            <button type="button" class="btn-pill primary" id="reload-history-btn">
              Truy vấn lịch sử
            </button>
          </div>
        </div>

        ${
          state.historyError
            ? `<div class="status-alert-bar" role="alert">
                 <span>${escapeHtml(state.historyError)}</span>
                 <button type="button" class="btn-pill" id="retry-history-btn">Thử lại</button>
               </div>`
            : ''
        }

        ${
          state.historyLoading
            ? `<div class="empty-state-box">
                 <div class="empty-state-title">Đang tải dữ liệu lịch sử cảm biến...</div>
               </div>`
            : points.length === 0
            ? `<div class="empty-state-box">
                 <div class="empty-state-title">Không có dữ liệu lịch sử trong khoảng thời gian đã chọn</div>
                 <p class="empty-state-desc">Hãy chọn khoảng thời gian rộng hơn hoặc kiểm tra thiết bị đã đẩy dữ liệu lên backend chưa.</p>
               </div>`
            : `
              <div class="data-table-wrap">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>Thời gian (time)</th>
                      <th>Mã thiết bị (device_id)</th>
                      <th>Loại cảm biến (sensor_type)</th>
                      <th style="text-align:right;">Giá trị đo (value)</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${points
                      .slice()
                      .reverse()
                      .slice(0, 50)
                      .map(
                        (pt) => `
                      <tr>
                        <td>${escapeHtml(formatDateTime(pt.time))}</td>
                        <td><code>${escapeHtml(pt.device_id)}</code></td>
                        <td>${escapeHtml(pt.sensor_type)}</td>
                        <td class="num"><strong>${escapeHtml(pt.value)}</strong></td>
                      </tr>
                    `
                      )
                      .join('')}
                  </tbody>
                </table>
              </div>
            `
        }
      </div>
    `;
  }

  private renderAlertsTab(state: DashboardState): string {
    return `
      <div class="glass-panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Danh sách Cảnh báo Hệ thống (<code>GET /api/v1/alerts?limit=100</code> &amp; WebSocket)</h2>
            <p class="panel-subtitle">
              Tự động bổ sung cảnh báo mới khi nhận sự kiện WebSocket <code>{ "event": "alert", "data": ... }</code>.
            </p>
          </div>
          <button type="button" class="btn-pill" id="reload-alerts-btn">
            ↻ Làm mới cảnh báo
          </button>
        </div>

        ${
          state.alertsError
            ? `<div class="status-alert-bar" role="alert">
                 <span>${escapeHtml(state.alertsError)}</span>
               </div>`
            : ''
        }

        ${
          state.alerts.length === 0
            ? `<div class="empty-state-box">
                 <div class="empty-state-title">Hiện chưa có cảnh báo nào</div>
                 <p class="empty-state-desc">Khi cảm biến vượt ngưỡng hoặc backend phát sự kiện cảnh báo qua WebSocket, thông tin sẽ xuất hiện tại đây.</p>
               </div>`
            : `
              <div class="data-table-wrap">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>Thời gian</th>
                      <th>Mức độ</th>
                      <th>Thiết bị</th>
                      <th>Nội dung cảnh báo</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${state.alerts
                      .map(
                        (a) => `
                      <tr>
                        <td>${escapeHtml(formatDateTime(a.created_at || a.timestamp || a.time))}</td>
                        <td>
                          <span class="status-pill ${
                            a.severity === 'critical' || a.severity === 'error'
                              ? 'danger'
                              : a.severity === 'warning'
                              ? 'amber'
                              : 'blue'
                          }">
                            ${escapeHtml(a.severity || 'warning')}
                          </span>
                        </td>
                        <td><code>${escapeHtml(a.device_id || 'system')}</code></td>
                        <td>${escapeHtml(a.message)}</td>
                      </tr>
                    `
                      )
                      .join('')}
                  </tbody>
                </table>
              </div>
            `
        }
      </div>
    `;
  }

  private bindDashboardEvents(state: DashboardState): void {
    // Tab switching
    this.root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab') as ActiveTab | null;
        if (tab) {
          this.store.setActiveTab(tab);
        }
      });
    });

    // Logout
    const logoutBtn = this.root.querySelector('#logout-btn');
    logoutBtn?.addEventListener('click', () => {
      this.store.logout();
    });

    // Device filter select
    const filterSelect = this.root.querySelector('#device-filter-select') as HTMLSelectElement | null;
    filterSelect?.addEventListener('change', () => {
      this.store.setSelectedDevice(filterSelect.value || 'all');
    });

    // Control buttons (Fan & Light)
    this.root.querySelectorAll<HTMLButtonElement>('[data-control-device]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const deviceId = btn.getAttribute('data-control-device');
        const target = btn.getAttribute('data-control-target') as ControlTarget | null;
        const action = btn.getAttribute('data-control-action') as ControlAction | null;
        if (deviceId && (target === 'fan' || target === 'light') && (action === 'turn_on' || action === 'turn_off')) {
          void this.store.sendControlCommand(deviceId, target, action);
        }
      });
    });

    // Refresh / Retry buttons
    const refreshAllBtn = this.root.querySelector('#refresh-all-btn');
    refreshAllBtn?.addEventListener('click', () => {
      if (state.mode === 'live') {
        void this.store.bootstrapLiveDashboard();
      } else {
        this.store.emitSimulatedTelemetryTick();
      }
    });

    const retryBootstrapBtn = this.root.querySelector('#retry-bootstrap-btn');
    retryBootstrapBtn?.addEventListener('click', () => {
      void this.store.bootstrapLiveDashboard();
    });

    const emptyReloadBtn = this.root.querySelector('#empty-reload-devices-btn');
    emptyReloadBtn?.addEventListener('click', () => {
      if (state.mode === 'live') {
        void this.store.bootstrapLiveDashboard();
      } else {
        this.store.setSimulationFaultMode('none');
      }
    });

    const emptySwitchSimBtn = this.root.querySelector('#empty-switch-sim-btn');
    emptySwitchSimBtn?.addEventListener('click', () => {
      this.store.enterSimulationMode();
    });

    const retryWsBtn = this.root.querySelector('#retry-ws-now-btn');
    retryWsBtn?.addEventListener('click', () => {
      this.wsClient.retryNow();
    });

    // Simulation mode controls
    const simPushTelemetryBtn = this.root.querySelector('#sim-push-telemetry-btn');
    simPushTelemetryBtn?.addEventListener('click', () => {
      this.store.emitSimulatedTelemetryTick();
    });

    const simPushAlertBtn = this.root.querySelector('#sim-push-alert-btn');
    simPushAlertBtn?.addEventListener('click', () => {
      this.store.prependRealtimeAlert({
        device_id: 'stm32-01',
        gateway_id: 'pi-gateway-01',
        severity: 'warning',
        message: `[Dữ liệu mô phỏng] Phát hiện nhiệt độ tăng nhanh qua ngưỡng cảnh báo (${(29 + Math.random() * 2).toFixed(1)}°C).`,
        created_at: new Date().toISOString(),
      });
    });

    const simFaultSelect = this.root.querySelector('#sim-fault-select') as HTMLSelectElement | null;
    simFaultSelect?.addEventListener('change', () => {
      const val = simFaultSelect.value as DashboardState['simulationFaultMode'];
      this.store.setSimulationFaultMode(val);
    });

    const exitSimBtn = this.root.querySelector('#exit-simulation-btn');
    exitSimBtn?.addEventListener('click', () => {
      this.store.logout();
    });

    // History filter controls
    const reloadHistoryBtn = this.root.querySelector('#reload-history-btn');
    const retryHistoryBtn = this.root.querySelector('#retry-history-btn');
    const triggerHistoryReload = () => {
      const typeEl = this.root.querySelector('#history-type-select') as HTMLSelectElement | null;
      const intEl = this.root.querySelector('#history-interval-select') as HTMLSelectElement | null;
      const hoursEl = this.root.querySelector('#history-hours-select') as HTMLSelectElement | null;
      void this.store.loadSensorHistory({
        sensorType: (typeEl?.value as SensorType) || state.historyFilter.sensorType,
        interval: (intEl?.value as HistoryInterval) || state.historyFilter.interval,
        lookbackHours: Number(hoursEl?.value || state.historyFilter.lookbackHours),
      });
    };
    reloadHistoryBtn?.addEventListener('click', triggerHistoryReload);
    retryHistoryBtn?.addEventListener('click', triggerHistoryReload);

    // Alerts reload
    const reloadAlertsBtn = this.root.querySelector('#reload-alerts-btn');
    reloadAlertsBtn?.addEventListener('click', () => {
      void this.store.reloadAlerts();
    });
  }
}

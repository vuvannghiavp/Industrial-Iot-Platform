import './styles/nocturne.css';
import { getAppConfig } from './config/env';
import { TokenStore } from './services/tokenStore';
import { SmartHomeApiClient } from './services/apiClient';
import { TelemetryWebSocketClient } from './services/wsClient';
import { DashboardStore } from './state/dashboardStore';
import { SmartHomeDashboardApp } from './ui/app';

export function bootstrapApp(rootElement?: HTMLElement): SmartHomeDashboardApp {
  const target = rootElement || document.getElementById('app');
  if (!target) {
    throw new Error('Không tìm thấy phần tử gốc #app để khởi tạo giao diện.');
  }

  const config = getAppConfig();
  const tokenStore = new TokenStore();

  let storeRef: DashboardStore | null = null;

  const apiClient = new SmartHomeApiClient({
    baseUrl: config.apiBaseUrl,
    tokenStore,
    onSessionExpired: (reason) => {
      storeRef?.handleSessionExpired(reason);
    },
  });

  const wsClient = new TelemetryWebSocketClient({
    wsBaseUrl: config.wsBaseUrl,
    tokenStore,
    pingIntervalMs: config.wsPingIntervalMs,
  });

  const store = new DashboardStore(tokenStore, apiClient, wsClient);
  storeRef = store;

  const app = new SmartHomeDashboardApp(target, store, apiClient, wsClient);
  app.mount();
  return app;
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      bootstrapApp();
    });
  } else {
    bootstrapApp();
  }
}

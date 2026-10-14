export interface AppConfig {
  apiBaseUrl: string;
  wsBaseUrl: string;
  wsPingIntervalMs: number;
}

const RUNTIME_API_URL_KEY = 'nocturne_runtime_api_base_url';

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function deriveWsBaseUrl(apiBaseUrl: string, explicitWsUrl?: string): string {
  if (explicitWsUrl && explicitWsUrl.trim().length > 0) {
    return normalizeBaseUrl(explicitWsUrl);
  }
  const normalized = normalizeBaseUrl(apiBaseUrl);
  if (normalized.startsWith('https://')) {
    return 'wss://' + normalized.slice('https://'.length);
  }
  if (normalized.startsWith('http://')) {
    return 'ws://' + normalized.slice('http://'.length);
  }
  return `ws://${normalized}`;
}

function getViteEnv(key: string): string | undefined {
  try {
    const meta = (globalThis as Record<string, unknown>).__VITE_ENV__ as Record<string, string> | undefined;
    if (meta && typeof meta[key] === 'string') {
      return meta[key];
    }
  } catch {
    // ignore
  }
  if (typeof process !== 'undefined' && process.env && typeof process.env[key] === 'string') {
    return process.env[key];
  }
  return undefined;
}

export function getAppConfig(): AppConfig {
  let storedRuntimeUrl: string | null = null;
  try {
    if (typeof sessionStorage !== 'undefined') {
      storedRuntimeUrl = sessionStorage.getItem(RUNTIME_API_URL_KEY);
    }
  } catch {
    storedRuntimeUrl = null;
  }

  const envApiUrl = getViteEnv('VITE_API_BASE_URL') || 'http://localhost:8000';
  const apiBaseUrl = normalizeBaseUrl(storedRuntimeUrl || envApiUrl);
  const envWsUrl = getViteEnv('VITE_WS_BASE_URL');
  const wsBaseUrl = deriveWsBaseUrl(apiBaseUrl, storedRuntimeUrl ? undefined : envWsUrl);

  const rawPing = Number(getViteEnv('VITE_WS_PING_INTERVAL_MS') || '25000');
  const wsPingIntervalMs = Number.isFinite(rawPing) && rawPing >= 1000 ? rawPing : 25000;

  return {
    apiBaseUrl,
    wsBaseUrl,
    wsPingIntervalMs,
  };
}

export function setRuntimeApiBaseUrl(url: string): AppConfig {
  const cleaned = normalizeBaseUrl(url || 'http://localhost:8000');
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(RUNTIME_API_URL_KEY, cleaned);
    }
  } catch {
    // ignore storage restrictions
  }
  return getAppConfig();
}

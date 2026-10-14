import { AuthTokens } from '../types/api';

const STORAGE_ACCESS_KEY = 'smarthome_auth_access';
const STORAGE_REFRESH_KEY = 'smarthome_auth_refresh';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Quản lý access_token và refresh_token an toàn:
 * - Ưu tiên lưu trong bộ nhớ RAM (in-memory) kết hợp sessionStorage của tab hiện tại
 *   để tránh lưu trữ lâu dài trên localStorage dễ bị lộ qua các phiên.
 * - Tuyệt đối không có hàm xuất hay log token ra console/UI.
 */
export class TokenStore {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private storage: StorageLike | null = null;

  constructor(customStorage?: StorageLike | null) {
    if (customStorage !== undefined) {
      this.storage = customStorage;
    } else {
      try {
        this.storage = typeof sessionStorage !== 'undefined' ? sessionStorage : null;
      } catch {
        this.storage = null;
      }
    }
    this.hydrateFromStorage();
  }

  private hydrateFromStorage(): void {
    if (!this.storage) return;
    try {
      this.accessToken = this.storage.getItem(STORAGE_ACCESS_KEY);
      this.refreshToken = this.storage.getItem(STORAGE_REFRESH_KEY);
    } catch {
      this.accessToken = null;
      this.refreshToken = null;
    }
  }

  public setTokens(tokens: AuthTokens): void {
    this.accessToken = tokens.access_token || null;
    this.refreshToken = tokens.refresh_token || null;
    if (!this.storage) return;
    try {
      if (this.accessToken) {
        this.storage.setItem(STORAGE_ACCESS_KEY, this.accessToken);
      } else {
        this.storage.removeItem(STORAGE_ACCESS_KEY);
      }
      if (this.refreshToken) {
        this.storage.setItem(STORAGE_REFRESH_KEY, this.refreshToken);
      } else {
        this.storage.removeItem(STORAGE_REFRESH_KEY);
      }
    } catch {
      // Fallback to in-memory only if storage quota/permissions fail
    }
  }

  public getAccessToken(): string | null {
    return this.accessToken;
  }

  public getRefreshToken(): string | null {
    return this.refreshToken;
  }

  public hasTokens(): boolean {
    return Boolean(this.accessToken);
  }

  public clearTokens(): void {
    this.accessToken = null;
    this.refreshToken = null;
    if (!this.storage) return;
    try {
      this.storage.removeItem(STORAGE_ACCESS_KEY);
      this.storage.removeItem(STORAGE_REFRESH_KEY);
    } catch {
      // ignore
    }
  }
}

import { useCallback } from 'react';

export function useApi(serverUrl: string, token: string) {
  const apiUrl = useCallback((path: string) => `${serverUrl.replace(/\/$/, '')}${path}`, [serverUrl]);

  const api = useCallback(
    async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
      const response = await fetch(apiUrl(path), {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(init.headers || {})
        }
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      return response.status === 204 ? (undefined as T) : response.json();
    },
    [apiUrl, token]
  );

  return { apiUrl, api };
}

export type ApiClient = ReturnType<typeof useApi>['api'];
export type ApiUrlBuilder = ReturnType<typeof useApi>['apiUrl'];

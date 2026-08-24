/**
 * Local player session (TDD D-D rejoin model).
 * Stored under 'aux:player'; identity is the server-minted token — never guessed client-side.
 */

export interface PlayerSession {
  playerToken: string;
  playerId: string;
  nickname: string;
  code: string;
}

const STORAGE_KEY = 'aux:player';

export function loadSession(): PlayerSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<PlayerSession>;
    if (
      typeof s.playerToken === 'string' &&
      s.playerToken.length > 0 &&
      typeof s.playerId === 'string' &&
      s.playerId.length > 0 &&
      typeof s.nickname === 'string' &&
      typeof s.code === 'string'
    ) {
      return {
        playerToken: s.playerToken,
        playerId: s.playerId,
        nickname: s.nickname,
        code: s.code,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveSession(session: PlayerSession): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    /* private mode etc. — join still works this tab, rejoin just won't */
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** ?code= from the URL — deep link https://aux.battle/r/KZXW style entries. */
export function readUrlCode(): string {
  return (new URLSearchParams(window.location.search).get('code') ?? '').trim().toUpperCase();
}

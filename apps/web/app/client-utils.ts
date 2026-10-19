export const TOKEN_KEY = 'school-crm-token';
export const ATTEMPT_KEY = 'school-crm-active-attempt';
export const ROOM_SESSION_PREFIX = 'zaily-room-session:';

export function roomSessionKey(roomId: string) {
  return `${ROOM_SESSION_PREFIX}${roomId}`;
}

export function storeRoomSession(storage: Pick<Storage, 'setItem' | 'removeItem'>, roomId: string, token: string) {
  if (!/^[A-Za-z0-9_-]{40,80}$/u.test(token)) return;
  writeStorage(storage, roomSessionKey(roomId), token);
}

export function readRoomSession(storage: Pick<Storage, 'getItem'>, roomId: string) {
  const token = readStorage(storage, roomSessionKey(roomId));
  return token && /^[A-Za-z0-9_-]{40,80}$/u.test(token) ? token : null;
}

export function clearRoomSession(storage: Pick<Storage, 'removeItem'>, roomId: string) {
  try { storage.removeItem(roomSessionKey(roomId)); } catch { /* Optional browser persistence. */ }
}

// Storage can be disabled by browser policy. Authentication still works in memory.
export function readStorage(storage: Pick<Storage, 'getItem'>, key: string): string | null {
  try { return storage.getItem(key); } catch { return null; }
}

export function writeStorage(storage: Pick<Storage, 'setItem' | 'removeItem'>, key: string, value: string | null) {
  try { if (value === null) storage.removeItem(key); else storage.setItem(key, value); } catch { /* Optional browser persistence. */ }
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 0) { super(message); this.name = 'ApiError'; this.status = status; }
}

export async function requestJson(baseUrl: string, path: string, token = '', options: RequestInit = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers(options.headers);
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  if (options.body && !isFormData && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
      ...options, headers, cache: 'no-store', signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const messages = Array.isArray(data?.message) ? data.message.filter((value: unknown) => typeof value === 'string').join('; ') : data?.message;
      throw new ApiError(typeof messages === 'string' && messages ? messages : `Ошибка API (${response.status})`, response.status);
    }
    if (data === null) throw new ApiError('Сервер вернул некорректный ответ', response.status);
    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(controller.signal.aborted ? 'Сервер не ответил вовремя. Повторите попытку.' : 'Нет связи с сервером. Проверьте подключение и повторите попытку.');
  } finally { clearTimeout(timer); }
}

export function isManualQuestion(type: string) {
  return ['SHORT_TEXT', 'LONG_TEXT', 'MATCHING', 'FILL_BLANKS', 'FILE_UPLOAD'].includes(type);
}

export function validPoints(value: number, minimum = 0) {
  return Number.isFinite(value) && value >= minimum && value <= 10000 && Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
}

// Free-form answers have no predefined maximum. Only automatic questions can
// truthfully contribute to a percentage; teacher-awarded points stay in totals.
export function automaticScoreRate(answers: Array<{ awardedPoints: unknown; question: { type: string; points: unknown } }>): number | null {
  const automatic = answers.filter(answer => !isManualQuestion(answer.question.type));
  if (!automatic.length || automatic.some(answer => answer.awardedPoints === null || answer.awardedPoints === undefined)) return null;
  const maximum = automatic.reduce((sum, answer) => sum + Number(answer.question.points), 0);
  if (!(maximum > 0)) return null;
  return Math.max(0, Math.min(100, automatic.reduce((sum, answer) => sum + Number(answer.awardedPoints), 0) / maximum * 100));
}

export function answerText(answer: { textValue?: string | null; numericValue?: number | string | null; jsonValue?: unknown; question: { options?: Array<{ id: string; text: string }> } }, empty: string) {
  if (answer.textValue) return answer.textValue;
  if (answer.numericValue !== null && answer.numericValue !== undefined) return String(answer.numericValue);
  const options = answer.question.options ?? [];
  const label = (id: string) => options.find(option => option.id === id)?.text || id;
  if (Array.isArray(answer.jsonValue)) return answer.jsonValue.filter((id): id is string => typeof id === 'string').map(label).join(', ') || empty;
  return typeof answer.jsonValue === 'string' && answer.jsonValue ? label(answer.jsonValue) : empty;
}

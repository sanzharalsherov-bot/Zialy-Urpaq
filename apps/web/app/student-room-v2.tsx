'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { clearRoomSession, readRoomSession, requestJson, storeRoomSession, writeStorage } from './client-utils';

const StudentScreenShare = dynamic(() => import('./room-screen-sharing').then(module => module.StudentScreenShare), { ssr: false });

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? '/api';
const ROOM_DEVICE_KEY = 'zaily-urpaq-room-device-id';
let fallbackRoomDeviceId = '';

function getRoomDeviceId() {
  try {
    const saved = window.localStorage.getItem(ROOM_DEVICE_KEY);
    if (saved && /^[A-Za-z0-9_-]{32,80}$/u.test(saved)) return saved;
  } catch { /* Use a tab-scoped fallback if browser storage is unavailable. */ }
  if (fallbackRoomDeviceId) return fallbackRoomDeviceId;
  const bytes = new Uint8Array(32);
  window.crypto.getRandomValues(bytes);
  const generated = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  try { window.localStorage.setItem(ROOM_DEVICE_KEY, generated); } catch { fallbackRoomDeviceId = generated; }
  return generated;
}
const ACTIVE_ROOM_KEY = 'zaily-active-room-v2';
const draftKey = (roomId: string) => `zaily-room-draft:${roomId}`;
const awayKey = (roomId: string) => `zaily-room-away:${roomId}`;
type Language = 'kk' | 'ru' | 'en';
type AnswerState = Record<string, string | string[]>;

const translations: Record<string, [string, string]> = {
  'Комната теста':['Тест бөлмесі','Test room'],'Код комнаты':['Бөлме коды','Room code'],'Подключиться':['Қосылу','Join room'],'Запустить тест':['Тестті бастау','Start test'],'Ожидаем учителя':['Мұғалімді күтіп отырмыз','Waiting for teacher'],'В комнате':['Бөлмеде','In room'],'Ответ сохранён':['Жауап сақталды','Answer saved'],'Отправить тест':['Тестті жіберу','Submit test'],'Осталось':['Қалды','Remaining'],'Тест завершён':['Тест аяқталды','Test finished'],'Ваш результат':['Нәтижеңіз','Your result'],'Правильных ответов':['Дұрыс жауап','Correct answers'],'Место':['Орын','Rank'],'Топ комнаты':['Бөлме үздіктері','Room leaderboard'],'Имя':['Аты','First name'],'Фамилия':['Тегі','Last name'],'Введите шестизначный код комнаты':['Бөлменің алты таңбалы кодын енгізіңіз','Enter the six-digit room code'],'Нет связи. Повторяем сохранение…':['Байланыс жоқ. Сақтау қайталанады…','Offline. Retrying save…'],'Закрыть результат':['Нәтижені жабу','Close result'],'Загрузка комнаты…':['Бөлме жүктелуде…','Loading room…'],'Повторное подключение не удалось. Введите код ещё раз.':['Қайта қосылу мүмкін болмады. Кодты қайта енгізіңіз.','Could not reconnect. Enter the code again.'],'Ученик':['Оқушы','Student'],'Баллов':['Ұпай','points'],'Ученик тестке қосылмады':['Оқушы тестке қосылмады','Could not join room'],'Ответы сохранены автоматически':['Жауаптар автоматты түрде сақталады','Answers are saved automatically'],'Обязательный вопрос':['Міндетті сұрақ','Required question'],
};
translations['Предупреждения о смене вкладки'] = ['Қойындыдан шығу ескертулері', 'Tab switch warnings'];
translations['Тест завершён после третьего предупреждения. Сохранённые ответы учтены.'] = ['Үшінші ескертуден кейін тест аяқталды. Сақталған жауаптар есептелді.', 'The test ended after the third warning. Saved answers were graded.'];

export function StudentRoomV2({ language, firstName, lastName }: { language: Language; firstName: string; lastName: string }) {
  const t = (text: string) => language === 'kk' ? translations[text]?.[0] ?? text : language === 'en' ? translations[text]?.[1] ?? text : text;
  const [code, setCode] = useState('');
  const [roomState, setRoomState] = useState<any>(null);
  const [sessionToken, setSessionToken] = useState('');
  const [answers, setAnswers] = useState<AnswerState>({});
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [clock, setClock] = useState(Date.now());
  const [loadingSession, setLoadingSession] = useState(true);
  const [onlineRetry, setOnlineRetry] = useState(0);
  const lastAutosaved = useRef('{}');
  const answersRef = useRef<AnswerState>({});
  const saveInFlight = useRef(false);
  useEffect(() => { answersRef.current = answers; }, [answers]);

  const token = useCallback((roomId: string) => readRoomSession(window.localStorage, roomId), []);
  const refresh = useCallback(async (roomId: string, bearer: string) => {
    const data = await requestJson(apiUrl, `/student/rooms/${roomId}/v2`, bearer);
    setRoomState(data);
    const saved = Object.fromEntries((data.submission?.answers || []).map((answer: any) => [answer.questionId, answer.jsonValue ?? '']));
    lastAutosaved.current = JSON.stringify(saved);
    let local: AnswerState = {};
    try { local = JSON.parse(window.localStorage.getItem(draftKey(roomId)) || '{}'); } catch { /* Ignore a damaged local draft. */ }
    setAnswers(current => ({ ...saved, ...local, ...current }));
    return data;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const restore = async () => {
      try {
        const raw = window.localStorage.getItem(ACTIVE_ROOM_KEY);
        const active = raw ? JSON.parse(raw) : null;
        if (!active?.roomId) return;
        const savedToken = token(active.roomId);
        if (!savedToken) return;
        const data = await refresh(active.roomId, savedToken);
        if (cancelled) return;
        setCode(active.code || ''); setSessionToken(savedToken);
      } catch {
        if (!cancelled) setMessage(t('Повторное подключение не удалось. Введите код ещё раз.'));
      } finally { if (!cancelled) setLoadingSession(false); }
    };
    void restore();
    return () => { cancelled = true; };
  }, [token, refresh]);

  const roomId = roomState?.room?.id;
  const status = roomState?.submission?.status;
  const questions = roomState?.questions ?? [];
  const remaining = useMemo(() => {
    const start = roomState?.room?.startedAt ? new Date(roomState.room.startedAt).getTime() : null;
    const minutes = roomState?.room?.durationMinutes;
    if (!start || !minutes) return null;
    return Math.max(0, Math.ceil((start + minutes * 60000 - clock) / 1000));
  }, [roomState?.room?.startedAt, roomState?.room?.durationMinutes, clock]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const online = () => setOnlineRetry(value => value + 1);
    window.addEventListener('online', online);
    const retry = window.setInterval(() => { if (navigator.onLine) setOnlineRetry(value => value + 1); }, 5000);
    return () => { window.removeEventListener('online', online); window.clearInterval(retry); };
  }, []);

  useEffect(() => {
    if (!roomId || !sessionToken || status !== 'WAITING') return;
    const poll = () => refresh(roomId, sessionToken).catch(() => {});
    void poll();
    const timer = window.setInterval(poll, 3000);
    return () => window.clearInterval(timer);
  }, [roomId, sessionToken, status, refresh]);

  const join = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return;
    setBusy(true); setMessage(''); setResult(null);
    try {
      const data = await requestJson(apiUrl, '/student/rooms/join-v2', '', { method: 'POST', body: JSON.stringify({ code, firstName, lastName, deviceId: getRoomDeviceId() }) });
      const bearer = data.sessionToken || token(data.roomId);
      if (!bearer) throw new Error('Session token was not returned');
      if (data.sessionToken) storeRoomSession(window.localStorage, data.roomId, data.sessionToken);
      window.localStorage.setItem(ACTIVE_ROOM_KEY, JSON.stringify({ roomId: data.roomId, code }));
      lastAutosaved.current = '{}';
      setSessionToken(bearer); setRoomState(data.studentRoom); setAnswers({});
    } catch (error) { setMessage(error instanceof Error ? error.message : t('Ученик тестке қосылмады')); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    if (!roomId || !sessionToken || status !== 'IN_PROGRESS') return;
    const serialized = JSON.stringify(answers);
    if (serialized === lastAutosaved.current) return;
    try { window.localStorage.setItem(draftKey(roomId), serialized); } catch { /* Keep the draft in memory when browser storage is unavailable. */ }
    const timer = window.setTimeout(async () => {
      // Never let an older debounced snapshot overwrite a newer answer or race another save.
      if (JSON.stringify(answersRef.current) !== serialized) { setOnlineRetry(value => value + 1); return; }
      if (saveInFlight.current) return;
      let previous: AnswerState = {};
      try { previous = JSON.parse(lastAutosaved.current); } catch { /* Treat a damaged snapshot as unsaved. */ }
      const changedAnswers = Object.entries(answers).filter(([questionId, value]) => JSON.stringify(previous[questionId]) !== JSON.stringify(value));
      if (!changedAnswers.length) {
        lastAutosaved.current = serialized;
        try { if (window.localStorage.getItem(draftKey(roomId)) === serialized) window.localStorage.removeItem(draftKey(roomId)); } catch { /* Ignore unavailable storage. */ }
        return;
      }
      saveInFlight.current = true;
      try {
        const saved = await requestJson(apiUrl, `/student/rooms/${roomId}/v2/answers`, sessionToken, { method: 'PATCH', body: JSON.stringify({ answers: changedAnswers.map(([questionId, value]) => ({ questionId, value })) }) });
        lastAutosaved.current = serialized;
        try { if (window.localStorage.getItem(draftKey(roomId)) === serialized) window.localStorage.removeItem(draftKey(roomId)); } catch { /* Server copy is already safe. */ }
        setMessage(saved.finished ? t('Тест завершён') : t('Ответ сохранён'));
      } catch { setMessage(t('Нет связи. Повторяем сохранение…')); }
      finally {
        saveInFlight.current = false;
        if (JSON.stringify(answersRef.current) !== serialized) setOnlineRetry(value => value + 1);
      }
    }, 700);
    return () => window.clearTimeout(timer);
  }, [answers, roomId, sessionToken, status, onlineRetry]);

  useEffect(() => {
    if (!roomId || !sessionToken || status !== 'IN_PROGRESS') return;
    let away = false;
    const report = async (eventType: 'VISIBILITY_HIDDEN' | 'VISIBILITY_RESTORED') => {
      try {
        const data = await requestJson(apiUrl, `/student/rooms/${roomId}/v2/proctor-events`, sessionToken, { method: 'POST', keepalive: true, body: JSON.stringify({ eventType }) });
        if (eventType === 'VISIBILITY_HIDDEN') {
          try { window.localStorage.setItem(awayKey(roomId), '1'); } catch { /* Proctor event is still submitted. */ }
          setRoomState((current: any) => current ? { ...current, submission: { ...current.submission, proctorWarnings: data.warnings } } : current);
          if (data.finished) {
            const ranking = await requestJson(apiUrl, `/student/rooms/${roomId}/v2/submit`, sessionToken, { method: 'POST', body: JSON.stringify({}) }).catch(() => null);
            if (ranking) setResult(ranking);
            await refresh(roomId, sessionToken);
            setMessage(t('Тест завершён после третьего предупреждения. Сохранённые ответы учтены.'));
          }
        } else {
          try { window.localStorage.removeItem(awayKey(roomId)); } catch { /* Ignore unavailable storage. */ }
        }
      } catch { /* Network and browser lifecycle failures are not cheating violations. */ }
    };
    const markAway = () => { if (!away) { away = true; void report('VISIBILITY_HIDDEN'); } };
    const onVisibilityChange = () => { if (document.visibilityState === 'hidden') markAway(); };
    const onVisible = () => {
      let persistedAway = false;
      try { persistedAway = window.localStorage.getItem(awayKey(roomId)) === '1'; } catch { /* Ignore unavailable storage. */ }
      if (away || persistedAway) { away = false; void report('VISIBILITY_RESTORED'); }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('blur', markAway);
    window.addEventListener('focus', onVisible);
    if (document.visibilityState === 'visible') onVisible();
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange); document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('blur', markAway); window.removeEventListener('focus', onVisible);
    };
  }, [roomId, sessionToken, status, refresh]);

  const submit = async () => {
    if (!roomId || !sessionToken || busy) return;
    setBusy(true); setMessage('');
    try {
      await requestJson(apiUrl, `/student/rooms/${roomId}/v2/answers`, sessionToken, { method: 'PATCH', body: JSON.stringify({ answers: Object.entries(answers).map(([questionId, value]) => ({ questionId, value })) }) });
      const data = await requestJson(apiUrl, `/student/rooms/${roomId}/v2/submit`, sessionToken, { method: 'POST', body: JSON.stringify({}) });
      setResult(data); await refresh(roomId, sessionToken);
    } catch (error) { setMessage(error instanceof Error ? error.message : t('Тест завершён')); }
    finally { setBusy(false); }
  };

  useEffect(() => { if (remaining === 0 && status === 'IN_PROGRESS') void submit(); }, [remaining, status]);

  const reset = () => {
    if (roomId) clearRoomSession(window.localStorage, roomId);
    writeStorage(window.localStorage, ACTIVE_ROOM_KEY, null);
    setRoomState(null); setSessionToken(''); setAnswers({}); setResult(null); setMessage(''); setCode('');
  };

  return <section className="panel workPanel roomV2Panel">
    {roomState?.submission?.proctorWarnings > 0 && <p className="proctorNotice" role="status">{t('Предупреждения о смене вкладки')}: {roomState.submission.proctorWarnings}/3</p>}
    {roomState?.submission?.finishReason === 'PROCTORING_VIOLATION_LIMIT' && <p className="proctorNotice" role="status">{t('Тест завершён после третьего предупреждения. Сохранённые ответы учтены.')}</p>}
    <div className="panelHead"><div><h3>{t('Комната теста')}</h3><p>{roomState?.room?.assignmentTitle || t('Введите шестизначный код комнаты')}</p></div>{status === 'IN_PROGRESS' && remaining !== null && <span className="status">{t('Осталось')} {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</span>}</div>
    {!roomState && <form className="roomJoinForm" onSubmit={join}><label>{t('Код комнаты')}<input autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} minLength={6} required value={code} onChange={event => setCode(event.target.value.replace(/\D/gu, '').slice(0, 6))} /></label><button className="primaryButton" disabled={busy || loadingSession}>{busy ? t('Загрузка комнаты…') : t('Подключиться')}</button></form>}
    {message && <p className="helperText" role="status">{message}</p>}
    {roomState && status === 'WAITING' && <div className="waitingRoomPanel roomV2Waiting"><span className="waitingRoomIcon">◷</span><h3>{t('Ожидаем учителя')}</h3><strong>{t('В комнате')}: {roomState.room.count}/{roomState.room.lobbyTarget ?? '—'}</strong><small>{t('Ответы сохранены автоматически')}</small></div>}
    {roomState && status === 'IN_PROGRESS' && <><StudentScreenShare roomId={roomState.room.id} sessionToken={sessionToken} language={language} onWarning={async data => {
      setRoomState((current: any) => current ? { ...current, submission: { ...current.submission, proctorWarnings: data.warnings } } : current);
      if (data.finished) {
        const ranking = await requestJson(apiUrl, `/student/rooms/${roomState.room.id}/v2/submit`, sessionToken, { method: 'POST', body: JSON.stringify({}) }).catch(() => null);
        if (ranking) setResult(ranking);
        await refresh(roomState.room.id, sessionToken);
        setMessage(t('Тест завершён после третьего предупреждения. Сохранённые ответы учтены.'));
      }
    }} /><div className="helperText">{t('Ответы сохранены автоматически')}</div>{questions.map((question: any, index: number) => <article className="studentQuestion" key={question.id}><span className="questionNumber">{index + 1}</span><div className="studentQuestionBody"><b>{question.prompt}</b>{question.required && <small>{t('Обязательный вопрос')} · {question.points} {t('Баллов')}</small>}{question.type === 'SINGLE_CHOICE' && question.options.map((option: any) => <label className="studentOption" key={option.id}><input type="radio" name={question.id} checked={answers[question.id] === option.id} onChange={() => setAnswers(old => ({ ...old, [question.id]: option.id }))} />{option.text}</label>)}{question.type === 'MULTIPLE_CHOICE' && question.options.map((option: any) => <label className="studentOption" key={option.id}><input type="checkbox" checked={Array.isArray(answers[question.id]) && answers[question.id].includes(option.id)} onChange={event => setAnswers(old => ({ ...old, [question.id]: event.target.checked ? [...(Array.isArray(old[question.id]) ? old[question.id] as string[] : []), option.id] : (Array.isArray(old[question.id]) ? old[question.id] as string[] : []).filter(id => id !== option.id) }))} />{option.text}</label>)}</div></article>)}<div className="formActions"><button className="primaryButton" disabled={busy} onClick={() => void submit()}>{t('Отправить тест')}</button></div></>}
    {(status === 'GRADED' || result) && <div className="roomV2Result"><h3>{t('Ваш результат')}</h3><strong>{result?.score ?? roomState?.submission?.score ?? '—'} {t('Баллов')}</strong><span>{t('Правильных ответов')}: {result?.correctCount ?? roomState?.submission?.correctCount ?? '—'}</span>{result?.rank && <span>{t('Место')}: #{result.rank}</span>}{result?.top?.length > 0 && <><h4>{t('Топ комнаты')}</h4>{result.top.map((item: any) => <div className="leaderboardRow" key={item.rank}><b>#{item.rank}</b><span>{item.lastName} {item.firstName}</span><span>{item.score} {t('Баллов')}</span></div>)}</>}<button className="secondaryButton" onClick={reset}>{t('Закрыть результат')}</button></div>}
  </section>;
}

'use client';
import { useEffect, useRef, useState } from 'react';
import { answerText, requestJson } from './client-utils';
type Language = 'ru' | 'kk' | 'en';
const words: Record<string, [string, string, string]> = {
  title: ['Наблюдение за тестом', 'Тестті бақылау', 'Live test monitor'],
  notice: ['Преподаватель видит сохранённые ответы, текущий вопрос и переключения вкладки. Демонстрация экрана включается только с вашего разрешения.', 'Мұғалім сақталған жауаптарды, ағымдағы сұрақты және қойынды ауысуын көреді. Экран тек сіздің рұқсатыңызбен көрсетіледі.', 'Your teacher sees saved answers, the current question and tab switches. Screen sharing requires your permission.'],
  share: ['Показать экран преподавателю', 'Экранды мұғалімге көрсету', 'Share screen with teacher'],
  stop: ['Остановить показ', 'Көрсетуді тоқтату', 'Stop sharing'],
  active: ['Демонстрация включена', 'Экран көрсетілуде', 'Screen sharing is on'],
  unsupported: ['Захват экрана недоступен в этом браузере. Преподаватель видит ход работы внутри теста. На телефоне другие приложения не видны.', 'Бұл браузерде экранды түсіру қолжетімсіз. Мұғалім тест ішіндегі жұмысты көреді. Телефондағы басқа қолданбалар көрінбейді.', 'This browser cannot capture your screen. Your teacher sees progress inside the test. Other phone apps are not visible.'],
  https: ['Для показа экрана откройте сайт по HTTPS или на localhost.', 'Экранды көрсету үшін сайтты HTTPS немесе localhost арқылы ашыңыз.', 'Open the site over HTTPS or localhost to share your screen.'],
  denied: ['Показ не начался. Разрешите доступ и выберите экран или окно.', 'Көрсету басталмады. Рұқсат беріп, экранды не терезені таңдаңыз.', 'Sharing did not start. Allow access and choose a screen or window.'],
  select: ['Выберите ученика для просмотра', 'Көру үшін оқушыны таңдаңыз', 'Select a student to view'],
  online: ['На связи', 'Байланыста', 'Online'], offline: ['Нет связи / завершено', 'Байланыс жоқ / аяқталды', 'Offline / finished'],
  hidden: ['Вкладка скрыта', 'Қойынды жасырылған', 'Tab hidden'], warnings: ['Предупреждения', 'Ескертулер', 'Warnings'],
  answers: ['Сохранённые ответы', 'Сақталған жауаптар', 'Saved answers'],
  waiting: ['Ожидание свежего кадра', 'Жаңа кадр күтілуде', 'Waiting for a fresh frame'],
  noScreen: ['Экран не транслируется. Ниже — работа внутри теста.', 'Экран көрсетілмейді. Төменде — тест ішіндегі жұмыс.', 'No screen is being shared. Test progress is shown below.'],
  current: ['Сейчас на экране теста', 'Тест экранында қазір', 'Current test question'],
  empty: ['Пока нет ответов', 'Әзірге жауап жоқ', 'No saved answers yet'],
  loading: ['Подключение…', 'Қосылуда…', 'Connecting…'],
  connection: ['Связь прервана. Повторяем подключение…', 'Байланыс үзілді. Қайта қосылуда…', 'Connection lost. Reconnecting…'],
  interval: ['Кадры обновляются примерно раз в 2 секунды. Запись не ведётся.', 'Кадрлар шамамен 2 секунд сайын жаңарады. Жазба сақталмайды.', 'Frames refresh about every 2 seconds. No recording is stored.'],
};
const tr = (lang: Language, key: string) => words[key]?.[lang === 'ru' ? 0 : lang === 'kk' ? 1 : 2] ?? key;
const api = process.env.NEXT_PUBLIC_API_URL ?? '/api';

export function StudentMonitor({ token, submissionId, language }: { token: string; submissionId: string; language: Language }) {
  const [sharing, setSharing] = useState(false);
  const [supported, setSupported] = useState(false);
  const [secure, setSecure] = useState(true);
  const [error, setError] = useState('');
  const stream = useRef<MediaStream | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const watching = useRef(false);
  const question = useRef<string | undefined>(undefined);
  const alive = useRef(true);
  const choosing = useRef(false);
  const stop = () => { stream.current?.getTracks().forEach(track => track.stop()); stream.current = null; if (video.current) video.current.srcObject = null; if (alive.current) setSharing(false); };
  useEffect(() => {
    alive.current = true;
    setSecure(window.isSecureContext);
    setSupported(typeof navigator.mediaDevices?.getDisplayMedia === 'function');
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(item => item.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (visible) question.current = (visible.target as HTMLElement).dataset.questionId;
    }, { threshold: [0.25, 0.5, 0.75] });
    document.querySelectorAll('[data-question-id]').forEach(element => observer.observe(element));
    return () => {
      alive.current = false; observer.disconnect(); stop();
      void fetch(`${api}/student/submissions/${submissionId}/monitor`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ visible: false, sharing: false }), keepalive: true }).catch(() => {});
    };
  }, [submissionId, token]);
  useEffect(() => {
    let cancelled = false; let inFlight = false;
    const pulse = async () => {
      if (inFlight) return; inFlight = true;
      try {
        const result = await requestJson(api, `/student/submissions/${submissionId}/monitor`, token, { method: 'POST', body: JSON.stringify({ visible: document.visibilityState === 'visible', sharing, questionId: question.current }) });
        if (!cancelled) watching.current = result.watching;
      } catch { watching.current = false; } finally { inFlight = false; }
    };
    void pulse(); const timer = window.setInterval(pulse, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [token, submissionId, sharing]);
  useEffect(() => {
    if (!sharing) return;
    let inFlight = false; let cancelled = false;
    const canvas = document.createElement('canvas');
    const timer = window.setInterval(async () => {
      const source = video.current;
      if (inFlight || !watching.current || !source?.videoWidth || source.readyState < 2) return;
      inFlight = true;
      try {
        const scale = Math.min(1, 1280 / source.videoWidth, 900 / source.videoHeight);
        canvas.width = Math.round(source.videoWidth * scale); canvas.height = Math.round(source.videoHeight * scale);
        canvas.getContext('2d')?.drawImage(source, 0, 0, canvas.width, canvas.height);
        let frame = canvas.toDataURL('image/jpeg', 0.6);
        if (frame.length > 133000) frame = canvas.toDataURL('image/jpeg', 0.3);
        if (!cancelled && frame.length <= 133000) await requestJson(api, `/student/submissions/${submissionId}/screen`, token, { method: 'POST', body: JSON.stringify({ frame }) });
      } catch { /* The next fresh frame replaces any lost frame. */ } finally { inFlight = false; }
    }, 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [token, submissionId, sharing]);
  const start = async () => {
    if (choosing.current) return; choosing.current = true; setError('');
    try {
      const media = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 2 }, audio: false });
      if (!alive.current) { media.getTracks().forEach(track => track.stop()); return; }
      stream.current = media;
      const player = document.createElement('video'); player.muted = true; player.playsInline = true; player.srcObject = media; video.current = player;
      media.getVideoTracks()[0].addEventListener('ended', stop, { once: true });
      await player.play(); setSharing(true);
    } catch { stop(); if (alive.current) setError(tr(language, 'denied')); }
    finally { choosing.current = false; }
  };
  return <aside className="studentMonitor"><p>{tr(language, 'notice')}</p>{sharing ? <><strong className="liveStatus">● {tr(language, 'active')}</strong><button type="button" className="secondaryButton" onClick={stop}>{tr(language, 'stop')}</button></> : supported ? <button type="button" className="secondaryButton" onClick={start}>{tr(language, 'share')}</button> : <small>{tr(language, secure ? 'unsupported' : 'https')}</small>}{error && <p role="alert">{error}</p>}</aside>;
}

export function TeacherMonitor({ token, assignmentId, language }: { token: string; assignmentId: string; language: Language }) {
  const [list, setList] = useState<any>(null);
  const [selected, setSelected] = useState('');
  const [detail, setDetail] = useState<any>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false; let loading = false;
    const poll = async () => { if (loading) return; loading = true; try { const result = await requestJson(api, `/assignments/${assignmentId}/monitor`, token); if (!disposed) { setList(result); setError(''); } } catch { if (!disposed) setError(tr(language, 'connection')); } finally { loading = false; } };
    void poll(); const timer = window.setInterval(poll, 5000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [token, assignmentId, language]);
  useEffect(() => {
    setDetail(null); if (!selected) return;
    let disposed = false; let loading = false;
    const poll = async () => { if (loading) return; loading = true; try { const result = await requestJson(api, `/submissions/${selected}/monitor`, token); if (!disposed) setDetail(result); } catch { if (!disposed) setDetail(null); } finally { loading = false; } };
    void poll(); const timer = window.setInterval(poll, 2000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [token, selected]);
  return <section className="liveMonitor"><h3>{tr(language, 'title')}</h3><p>{tr(language, 'interval')}</p>{error && <p role="status">{error}</p>}<div className="monitorLayout"><div className="monitorStudents">{!list && <p>{tr(language, 'loading')}</p>}{list?.students.map((s: any) => <button type="button" key={s.id} aria-pressed={selected === s.id} onClick={() => setSelected(s.id)}><b>{s.studentLastName} {s.studentFirstName} · #{s.attemptNo}</b><span>{s.online ? '● ' + tr(language, 'online') : tr(language, 'offline')} · {s._count.answers}/{list.assignment._count.questions}</span><small>{s.visible === false ? tr(language, 'hidden') + ' · ' : ''}{tr(language, 'warnings')}: {s.proctorWarnings}/3{s.sharing ? ' · ▣' : ''}</small></button>)}</div><div className="monitorDetail">{!selected ? <p>{tr(language, 'select')}</p> : !detail ? <p>{tr(language, 'connection')}</p> : <><h4>{detail.studentLastName} {detail.studentFirstName}</h4>{detail.frame ? <img className="monitorFrame" src={detail.frame} alt={tr(language, 'active')} /> : <p className="monitorPlaceholder">{tr(language, detail.sharing ? 'waiting' : 'noScreen')}</p>}{detail.currentQuestion && <p><b>{tr(language, 'current')}: </b>{detail.currentQuestion}</p>}<h4>{tr(language, 'answers')}</h4>{detail.answers.length ? detail.answers.map((a: any) => <div className="monitorAnswer" key={a.questionId}><b>{a.question.prompt}</b><p>{answerText(a, '—')}</p></div>) : <p>{tr(language, 'empty')}</p>}</>}</div></div></section>;
}

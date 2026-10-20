"use client";

import { useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track, type RemoteTrack } from 'livekit-client';
import { readStorage, requestJson, TOKEN_KEY } from './client-utils';

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? '/api';
type Language = 'kk' | 'ru' | 'en';
const copy = {
  start: ['Показать экран учителю', 'Мұғалімге экранды көрсету', 'Share screen with teacher'],
  stop: ['Остановить трансляцию', 'Таратуды тоқтату', 'Stop sharing'],
  consent: ['Экран будет виден преподавателю. Перед началом закройте личные сообщения.', 'Экран мұғалімге көрінеді. Бастамас бұрын жеке хабарламаларды жабыңыз.', 'Your screen will be visible to the teacher. Close personal messages first.'],
  unsupported: ['Этот браузер не разрешает показывать экран. На телефоне возможность зависит от браузера и системы.', 'Бұл браузер экранды көрсетуге рұқсат бермейді. Телефонда қолдау браузер мен жүйеге байланысты.', 'This browser cannot share its screen. Phone support depends on the browser and OS.'],
  https: ['Для трансляции нужен защищённый HTTPS-сайт.', 'Трансляция үшін қорғалған HTTPS сайты қажет.', 'Screen sharing requires a secure HTTPS site.'],
  startError: ['Не удалось начать трансляцию. Проверьте сеть и разрешение браузера.', 'Трансляцияны бастау мүмкін болмады. Желіні және браузер рұқсатын тексеріңіз.', 'Could not start sharing. Check your network and browser permission.'],
  staffTitle: ['Трансляции учеников', 'Оқушылар трансляциясы', 'Student screen shares'],
  waiting: ['Пока нет трансляций', 'Әзірге трансляция жоқ', 'No active screen shares yet'],
  loading: ['Подключаем просмотр…', 'Көру қосылуда…', 'Connecting to screen shares…'],
  unavailable: ['Просмотр трансляций сейчас недоступен.', 'Трансляцияларды көру әзірге қолжетімсіз.', 'Screen monitoring is currently unavailable.'],
  students: ['учеников показывают экран', 'оқушы экран көрсетіп отыр', 'students are sharing'],
} as const;
const text = (language: Language, key: keyof typeof copy) => copy[key][language === 'kk' ? 1 : language === 'en' ? 2 : 0];

export function StudentScreenShare({ roomId, sessionToken, language, onWarning }: { roomId: string; sessionToken: string; language: Language; onWarning?: (data: { warnings: number; finished: boolean }) => void }) {
  const [sharing, setSharing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const roomRef = useRef<Room | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const endedReportedRef = useRef(false);

  const reportProctorEvent = async (eventType: 'SCREEN_SHARE_ENDED' | 'SCREEN_SHARE_RESTORED') => {
    try {
      const data = await requestJson(apiUrl, `/student/rooms/${roomId}/v2/proctor-events`, sessionToken, { method: 'POST', keepalive: true, body: JSON.stringify({ eventType }) });
      if (eventType === 'SCREEN_SHARE_ENDED') onWarning?.({ warnings: data.warnings, finished: data.finished });
      return data;
    } catch {
      setMessage(text(language, 'startError'));
      return null;
    }
  };

  const stop = async (reportViolation = false) => {
    const room = roomRef.current;
    const stream = streamRef.current;
    if (reportViolation && room && !endedReportedRef.current) {
      endedReportedRef.current = true;
      await reportProctorEvent('SCREEN_SHARE_ENDED');
    }
    roomRef.current = null;
    streamRef.current = null;
    try { if (room) await room.disconnect(); } catch { /* Disconnect cleanup is best effort. */ }
    stream?.getTracks().forEach(track => track.stop());
    setSharing(false);
  };

  useEffect(() => () => {
    const room = roomRef.current;
    const stream = streamRef.current;
    roomRef.current = null;
    streamRef.current = null;
    void room?.disconnect();
    stream?.getTracks().forEach(track => track.stop());
  }, []);

  const start = async () => {
    if (busy || sharing) return;
    setMessage('');
    if (!window.isSecureContext) { setMessage(text(language, 'https')); return; }
    if (!navigator.mediaDevices?.getDisplayMedia) { setMessage(text(language, 'unsupported')); return; }
    setBusy(true);
    let captured: MediaStream | null = null;
    let room: Room | null = null;
    try {
      // Capture must be initiated directly from this click; browsers reject deferred capture prompts.
      captured = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 8, max: 12 }, width: { ideal: 1280 } }, audio: false });
      const credentials = await requestJson(apiUrl, `/student/rooms/${roomId}/v2/livekit-token`, sessionToken, { method: 'POST', body: JSON.stringify({}) });
      room = new Room({ adaptiveStream: true, dynacast: true });
      await room.connect(credentials.url, credentials.token);
      const video = captured.getVideoTracks()[0];
      if (!video) throw new Error('No screen video track');
      await room.localParticipant.publishTrack(video, { source: Track.Source.ScreenShare, name: 'screen' });
      roomRef.current = room;
      streamRef.current = captured;
      endedReportedRef.current = false;
      await reportProctorEvent('SCREEN_SHARE_RESTORED');
      video.addEventListener('ended', () => { void stop(true); }, { once: true });
      setSharing(true);
    } catch {
      captured?.getTracks().forEach(track => track.stop());
      await room?.disconnect();
      setMessage(text(language, 'startError'));
    } finally { setBusy(false); }
  };

  return <aside className="roomSharePanel"><div><b>{text(language, 'start')}</b><small>{text(language, 'consent')}</small>{message && <small role="status">{message}</small>}</div>{sharing ? <button type="button" className="secondaryButton" onClick={() => void stop(true)}>{text(language, 'stop')}</button> : <button type="button" className="secondaryButton" disabled={busy} onClick={() => void start()}>{busy ? text(language, 'loading') : text(language, 'start')}</button>}</aside>;
}

type SharedTrack = { participantId: string; name: string; track: RemoteTrack };
export function TeacherScreenMonitor({ roomId, language }: { roomId: string; language: Language }) {
  const [tracks, setTracks] = useState<SharedTrack[]>([]);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const refs = useRef(new Map<string, RemoteTrack>());

  useEffect(() => {
    let disposed = false;
    let room: Room | undefined;
    const token = readStorage(window.sessionStorage, TOKEN_KEY);
    if (!token) { setFailed(true); return; }
    let rosterNames = new Map<string, string>();
    const add = (track: RemoteTrack, participant: { identity: string; name?: string }) => {
      if (track.source !== Track.Source.ScreenShare) return;
      refs.current.set(participant.identity, track);
      const participantId = participant.identity.replace(/^student:/u, '');
      setTracks(current => [...current.filter(item => item.participantId !== participant.identity), { participantId: participant.identity, name: rosterNames.get(participantId) || participant.name || participant.identity, track }]);
    };
    const remove = (track: RemoteTrack, participant: { identity: string }) => {
      if (track.source !== Track.Source.ScreenShare) return;
      track.detach(); refs.current.delete(participant.identity);
      setTracks(current => current.filter(item => item.participantId !== participant.identity));
    };
    void (async () => {
      try {
        const [credentials, roster] = await Promise.all([
          requestJson(apiUrl, `/rooms/${roomId}/livekit-token`, token, { method: 'POST', body: JSON.stringify({}) }),
          requestJson(apiUrl, `/rooms/${roomId}`, token),
        ]);
        rosterNames = new Map((roster.participants || []).map((participant: any) => [participant.id, `${participant.lastName} ${participant.firstName}`]));
        if (disposed) return;
        room = new Room({ adaptiveStream: true, dynacast: true });
        room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => add(track, participant));
        room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => remove(track, participant));
        room.on(RoomEvent.Disconnected, () => { if (!disposed) setFailed(true); });
        await room.connect(credentials.url, credentials.token);
        if (!disposed) {
          for (const participant of room.remoteParticipants.values()) {
            for (const publication of participant.trackPublications.values()) if (publication.track && publication.source === Track.Source.ScreenShare) add(publication.track as RemoteTrack, participant);
          }
          setReady(true);
        }
      } catch { if (!disposed) setFailed(true); }
    })();
    return () => { disposed = true; refs.current.forEach(track => track.detach()); refs.current.clear(); void room?.disconnect(); };
  }, [roomId]);

  return <section className="teacherSharePanel"><div className="sharePanelHeading"><b>{text(language, 'staffTitle')}</b><span>{tracks.length} {text(language, 'students')}</span></div>{failed ? <p role="status">{text(language, 'unavailable')}</p> : !ready || !tracks.length ? <p>{text(language, ready ? 'waiting' : 'loading')}</p> : <div className="shareVideoGrid">{tracks.map(item => <article key={item.participantId}><video autoPlay playsInline ref={element => { if (element) item.track.attach(element); else item.track.detach(); }} /><b>{item.name}</b></article>)}</div>}</section>;
}

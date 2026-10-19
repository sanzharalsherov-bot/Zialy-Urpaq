'use client';

import { FormEvent, useEffect, useState } from 'react';
import { StudentRoomV2 } from '../student-room-v2';

type Language = 'kk' | 'ru' | 'en';
const NAME_KEY = 'zaily-room-student-name';
const text: Record<string, [string, string]> = {
  'Вход в тест':['Тестке кіру','Join a test'],'Введите имя и фамилию':['Аты-жөніңізді енгізіңіз','Enter your first and last name'],'Имя':['Аты','First name'],'Фамилия':['Тегі','Last name'],'Продолжить':['Жалғастыру','Continue'],'Язык':['Тіл','Language'],'Вернуться на главную':['Басты бетке оралу','Back to main page'],
};

export default function RoomPage() {
  const [language, setLanguage] = useState<Language>('ru');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [ready, setReady] = useState(false);
  const t = (value: string) => language === 'kk' ? text[value]?.[0] ?? value : language === 'en' ? text[value]?.[1] ?? value : value;

  useEffect(() => {
    try {
      const name = JSON.parse(sessionStorage.getItem(NAME_KEY) || 'null');
      if (name?.firstName && name?.lastName) { setFirstName(name.firstName); setLastName(name.lastName); setReady(true); }
    } catch { /* Start with an empty name form if storage is unavailable. */ }
  }, []);

  const continueToRoom = (event: FormEvent) => {
    event.preventDefault();
    const first = firstName.trim().replace(/\s+/gu, ' '); const last = lastName.trim().replace(/\s+/gu, ' ');
    if (!first || !last) return;
    setFirstName(first); setLastName(last); setReady(true);
    try { sessionStorage.setItem(NAME_KEY, JSON.stringify({ firstName: first, lastName: last })); } catch { /* In-memory use remains available. */ }
  };

  return <main className="roomEntryShell">
    <header className="roomEntryHeader"><a className="roomEntryBrand" href="/">Zaily Urpaq <span>мектебі</span></a><label>{t('Язык')}<select value={language} onChange={event => setLanguage(event.target.value as Language)}><option value="kk">Қазақша</option><option value="ru">Русский</option><option value="en">English</option></select></label></header>
    <div className="roomEntryContent"><div className="roomEntryIntro"><span className="eyebrow">ZAILY URPAQ · LEARNING</span><h1>{t('Вход в тест')}</h1><p>{t('Введите имя и фамилию')}</p></div>
      {!ready ? <form className="panel formStack roomEntryForm" onSubmit={continueToRoom}><label>{t('Имя')}<input value={firstName} onChange={event => setFirstName(event.target.value)} required maxLength={100} autoComplete="given-name" /></label><label>{t('Фамилия')}<input value={lastName} onChange={event => setLastName(event.target.value)} required maxLength={100} autoComplete="family-name" /></label><button className="primaryButton">{t('Продолжить')}</button></form> : <StudentRoomV2 language={language} firstName={firstName} lastName={lastName} />}
      <a className="roomEntryBack" href="/">← {t('Вернуться на главную')}</a>
    </div>
  </main>;
}

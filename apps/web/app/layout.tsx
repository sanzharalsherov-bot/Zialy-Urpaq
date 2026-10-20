import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Zialy Urpaq мектебі | Учебная платформа',
  description: 'Учебная платформа школы Zialy Urpaq: задания, ответы и результаты обучения',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body>{children}</body></html>;
}

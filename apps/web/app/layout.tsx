import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Zaily Urpaq МЕКТЕБІ | Учебная платформа',
  description: 'Учебная платформа школы Zaily Urpaq: задания, ответы и результаты обучения',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body>{children}</body></html>;
}

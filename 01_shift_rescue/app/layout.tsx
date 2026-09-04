import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL ?? 'https://shift-rescue-visual-agent.rocky-pearl-9123.chatgpt.site'),
  title: 'SHIFT//RESCUE — Visual Agent Test Game',
  description: '화면만 보는 AI의 인식, 계획, 조작과 오류 복구 능력을 시험하는 우주 정거장 관제 게임',
  openGraph: {
    title: 'SHIFT//RESCUE',
    description: '이미지만 보는 AI의 인식, 계획, 조작과 오류 복구 능력을 시험하세요.',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'SHIFT//RESCUE — Visual Agent Test' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'SHIFT//RESCUE',
    description: '이미지만 보는 AI의 관제 능력 테스트 게임',
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>{children}</body></html>;
}

'use client';

import { Suspense } from 'react';
import UnifiedHome from '@/components/Unified/UnifiedHome';

/**
 * Главный экран INmeet - один на всё: список встреч, выбранная встреча (резюме + расшифровка)
 * и идущая запись. Раньше было три экрана (Главная / Встреча / Запись); старые адреса
 * /meeting-details?id=... и /record ведут сюда же.
 */
export default function Home() {
  return (
    <Suspense fallback={<div className="h-screen w-full bg-im-bg" />}>
      <UnifiedHome />
    </Suspense>
  );
}

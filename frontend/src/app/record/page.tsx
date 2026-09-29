"use client"

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Адрес экрана записи. Запись теперь идёт на главном экране (/): если она идёт, там сразу
 * видна живая расшифровка и плашка «Стоп». Сам по себе адрес запись не запускает.
 */
export default function RecordRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/');
  }, [router]);
  return <div className="h-screen w-full bg-im-bg" />;
}

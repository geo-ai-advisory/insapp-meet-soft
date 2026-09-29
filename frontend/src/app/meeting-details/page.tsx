"use client"

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * Старый адрес экрана встречи. Встреча теперь открывается на главном экране:
 * /meeting-details?id=X[&source=recording] -> /?id=X[&source=recording].
 * Адрес оставлен рабочим для уведомлений, старых ссылок и всплывашек.
 */
function RedirectToHome() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const id = searchParams.get('id');
    const source = searchParams.get('source');
    const q = new URLSearchParams();
    if (id) q.set('id', id);
    if (source) q.set('source', source);
    const qs = q.toString();
    router.replace(qs ? `/?${qs}` : '/');
  }, [router, searchParams]);

  return <div className="h-screen w-full bg-im-bg" />;
}

export default function MeetingDetails() {
  return (
    <Suspense fallback={<div className="h-screen w-full bg-im-bg" />}>
      <RedirectToHome />
    </Suspense>
  );
}

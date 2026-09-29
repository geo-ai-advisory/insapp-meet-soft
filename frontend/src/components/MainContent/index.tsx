'use client';
// УСТАРЕЛО (29.09.2026): файл больше не подключён - главный экран теперь components/Unified/*
// (см. design-2026-09-29/impl/CHANGES.md). Не править; удалить отдельной чисткой.

import React from 'react';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';

interface MainContentProps {
  children: React.ReactNode;
}

const MainContent: React.FC<MainContentProps> = ({ children }) => {
  const { isCollapsed } = useSidebar();

  return (
    <main
      className={`flex-1 transition-all duration-300 ${
        isCollapsed ? 'ml-16' : 'ml-[232px]'
      }`}
    >
      {children}
    </main>
  );
};

export default MainContent;

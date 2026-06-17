import React, { useState, useEffect } from "react";
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import Image from 'next/image';
import AnalyticsConsentSwitch from "./AnalyticsConsentSwitch";
import { UpdateDialog } from "./UpdateDialog";
import { updateService, UpdateInfo } from '@/services/updateService';
import { Button } from './ui/button';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';


export function About() {
    const [currentVersion, setCurrentVersion] = useState<string>('');
    const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
    const [isChecking, setIsChecking] = useState(false);
    const [showUpdateDialog, setShowUpdateDialog] = useState(false);

    useEffect(() => {
        // Get current version on mount
        getVersion().then(setCurrentVersion).catch(console.error);
    }, []);

    const handleCheckForUpdates = async () => {
        setIsChecking(true);
        try {
            const info = await updateService.checkForUpdates(true);
            setUpdateInfo(info);
            if (info.available) {
                setShowUpdateDialog(true);
            } else {
                toast.success('Установлена последняя версия');
            }
        } catch (error: any) {
            console.error('Failed to check for updates:', error);
            toast.error('Не удалось проверить обновления: ' + (error.message || 'Неизвестная ошибка'));
        } finally {
            setIsChecking(false);
        }
    };

    return (
        <div className="p-4 space-y-4 h-[80vh] overflow-y-auto">
            {/* Compact Header */}
            <div className="text-center">
                <div className="mb-3">
                    <Image
                        src="icon_128x128.png"
                        alt="Insapp-meet"
                        width={64}
                        height={64}
                        className="mx-auto"
                    />
                </div>
                <h1 className="text-xl font-bold text-foreground">Insapp-meet</h1>
                <span className="text-sm text-muted-foreground"> v{currentVersion}</span>
                <p className="text-medium text-muted-foreground mt-1">
                    Корпоративный записчик встреч с локальной расшифровкой
                </p>
                <div className="mt-3">
                    <Button
                        onClick={handleCheckForUpdates}
                        disabled={isChecking}
                        variant="outline"
                        size="sm"
                        className="text-xs"
                    >
                        {isChecking ? (
                            <>
                                <Loader2 className="h-3 w-3 mr-2 animate-spin" />
                                Проверяю...
                            </>
                        ) : (
                            <>
                                <CheckCircle2 className="h-3 w-3 mr-2" />
                                Проверить обновления
                            </>
                        )}
                    </Button>
                    {updateInfo?.available && (
                        <div className="mt-2 text-xs text-blue-600">
                            Доступно обновление: v{updateInfo.version}
                        </div>
                    )}
                </div>
            </div>

            {/* Features Grid - Compact */}
            <div className="space-y-3">
                <h2 className="text-base font-semibold text-foreground">Что внутри</h2>
                <div className="grid grid-cols-2 gap-2">
                    <div className="bg-background rounded p-3 hover:bg-secondary transition-colors">
                        <h3 className="font-bold text-sm text-foreground mb-1">Полная приватность</h3>
                        <p className="text-xs text-muted-foreground leading-relaxed">Все данные и AI-обработка остаются на твоём устройстве. Никакого облака, никаких утечек.</p>
                    </div>
                    <div className="bg-background rounded p-3 hover:bg-secondary transition-colors">
                        <h3 className="font-bold text-sm text-foreground mb-1">Любая модель</h3>
                        <p className="text-xs text-muted-foreground leading-relaxed">Локальная open-source модель или внешнее API — без привязки к одному вендору.</p>
                    </div>
                    <div className="bg-background rounded p-3 hover:bg-secondary transition-colors">
                        <h3 className="font-bold text-sm text-foreground mb-1">Без подписок</h3>
                        <p className="text-xs text-muted-foreground leading-relaxed">Никаких ежемесячных оплат. Запускаешь модели локально или выбираешь облако только там где надо.</p>
                    </div>
                    <div className="bg-background rounded p-3 hover:bg-secondary transition-colors">
                        <h3 className="font-bold text-sm text-foreground mb-1">Где угодно</h3>
                        <p className="text-xs text-muted-foreground leading-relaxed">Telemost, Zoom, Google Meet, Teams — онлайн и офлайн.</p>
                    </div>
                </div>
            </div>

            {/* Footer - Compact */}
            <div className="pt-2 border-t border-border text-center">
                <p className="text-xs text-muted-foreground">
                    Insapp · построено на open-source ядре Meetily (MIT)
                </p>
            </div>
            <AnalyticsConsentSwitch />

            {/* Update Dialog */}
            <UpdateDialog
                open={showUpdateDialog}
                onOpenChange={setShowUpdateDialog}
                updateInfo={updateInfo}
            />
        </div>

    )
}

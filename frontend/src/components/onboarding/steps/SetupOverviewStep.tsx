import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { OnboardingContainer } from '../OnboardingContainer';
import { useOnboarding } from '@/contexts/OnboardingContext';

export function SetupOverviewStep() {
  const { goNext } = useOnboarding();
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    const checkPlatform = async () => {
      try {
        const { platform } = await import('@tauri-apps/plugin-os');
        setIsMac(platform() === 'macos');
      } catch (e) {
        setIsMac(navigator.userAgent.includes('Mac'));
      }
    };
    checkPlatform();
  }, []);

  const steps = [
    {
      number: 1,
      title: 'Скачать модель распознавания речи',
    },
    {
      number: 2,
      title: 'Выдать разрешения на микрофон и системный звук',
    },
  ];

  const handleContinue = () => {
    goNext();
  };

  return (
    <OnboardingContainer
      title="Что будем настраивать"
      description="Insapp-meet нужен один раз скачать модель распознавания речи и получить разрешения на микрофон. AI-резюме делается через внешний CLI (Claude Code / Codex) - его настроим позже."
      step={2}
      totalSteps={isMac ? 4 : 3}
    >
      <div className="flex flex-col items-center space-y-10">
        {/* Steps Card */}
        <div className="w-full max-w-md bg-white rounded-lg border border-gray-200 p-4">
          <div className="space-y-4">
            {steps.map((step) => (
              <div
                key={step.number}
                className="flex items-start gap-4 p-1"
              >
                <div className="flex-1 ml-1">
                  <h3 className="font-medium text-gray-900 flex items-center gap-2">
                    Шаг {step.number}: {step.title}
                  </h3>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* CTA Section */}
        <div className="w-full max-w-xs space-y-4">
          <Button
            onClick={handleContinue}
            className="w-full h-11 bg-gray-900 hover:bg-gray-800 text-white"
          >
            Поехали
          </Button>
        </div>
      </div>
    </OnboardingContainer>
  );
}

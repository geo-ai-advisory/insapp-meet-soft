"use client"

import { Switch } from "./ui/switch"
import { FlaskConical, AlertCircle } from "lucide-react"
import { useConfig } from "@/contexts/ConfigContext"
import {
  BetaFeatureKey,
  BETA_FEATURE_NAMES,
  BETA_FEATURE_DESCRIPTIONS
} from "@/types/betaFeatures"

export function BetaSettings() {
  const { betaFeatures, toggleBetaFeature } = useConfig();

  // Define feature order for display (allows custom ordering)
  const featureOrder: BetaFeatureKey[] = ['importAndRetranscribe'];

  return (
    <div className="space-y-6">
      {/* Yellow Warning Banner */}
      <div className="flex items-start gap-3 p-4 bg-yellow-50 border border-yellow-200 dark:bg-yellow-950/40 dark:border-yellow-900 rounded-lg">
        <AlertCircle className="h-5 w-5 text-yellow-600 dark:text-yellow-400 flex-shrink-0 mt-0.5" />
        <div className="text-sm text-yellow-800 dark:text-yellow-300">
          <p className="font-medium">Бета-фичи</p>
          <p className="mt-1">
            Эти возможности ещё тестируются. Могут быть глюки - дай знать если что найдёшь.
          </p>
        </div>
      </div>

      {/* Dynamic Feature Toggles - Automatically renders all features */}
      {featureOrder.map((featureKey) => (
        <div
          key={featureKey}
          className="bg-card rounded-lg border border-border p-6 shadow-sm"
        >
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-2">
                <FlaskConical className="h-5 w-5 text-muted-foreground" />
                <h3 className="text-lg font-semibold text-foreground">
                  {BETA_FEATURE_NAMES[featureKey]}
                </h3>
                <span className="px-2 py-0.5 text-xs font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-300 rounded-full">
                  BETA
                </span>
              </div>
              <p className="text-sm text-muted-foreground">
                {BETA_FEATURE_DESCRIPTIONS[featureKey]}
              </p>
            </div>

            <div className="ml-6">
              <Switch
                checked={betaFeatures[featureKey]}
                onCheckedChange={(checked) => toggleBetaFeature(featureKey, checked)}
              />
            </div>
          </div>
        </div>
      ))}

      {/* Info Box */}
      <div className="p-4 bg-accent border border-border rounded-lg">
        <p className="text-sm text-accent-foreground">
          <strong>Примечание:</strong> Если выключить - бета-фичи спрячутся. Существующие встречи не пострадают.
        </p>
      </div>
    </div>
  );
}

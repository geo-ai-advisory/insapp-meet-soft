import { ModelConfig } from "@/components/ModelSettingsModal";
import { PreferenceSettings } from "@/components/PreferenceSettings";
import { DeviceSelection } from "@/components/DeviceSelection";
import { LanguageSelection } from "@/components/LanguageSelection";
import { TranscriptSettings } from "@/components/TranscriptSettings";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { X } from "lucide-react";
import { toast } from "sonner";
import { useConfig } from "@/contexts/ConfigContext";
import { useRecordingState } from "@/contexts/RecordingStateContext";

type modalType = "modelSettings" | "deviceSettings" | "languageSettings" | "modelSelector" | "errorAlert" | "chunkDropWarning";

/**
 * SettingsModals Component
 *
 * All settings modals consolidated into a single component.
 * Uses ConfigContext and RecordingStateContext internally - no prop drilling needed!
 *
 * Визуально перенесён на дизайн-систему Insapp Pro (вариант B): карточки на токенах
 * bg-card / border-border, оверлей bg-foreground/40, синие кнопки bg-primary,
 * тёмная и светлая темы. Поток данных и invoke не менялись.
 */

interface SettingsModalsProps {
  modals: {
    modelSettings: boolean;
    deviceSettings: boolean;
    languageSettings: boolean;
    modelSelector: boolean;
    errorAlert: boolean;
    chunkDropWarning: boolean;
  };
  messages: {
    errorAlert: string;
    chunkDropWarning: string;
    modelSelector: string;
  };
  onClose: (name: modalType) => void;
}

// Общие классы (дизайн-система Insapp Pro)
const overlayCls = "fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 backdrop-blur-[2px] animate-fade-in";
const cardCls = "bg-card text-card-foreground border border-border rounded-2xl shadow-2xl";
const closeBtnCls = "flex-none w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors";
const selectCls = "px-3 py-2 text-sm text-foreground bg-background border border-border rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-primary transition-colors";
const btnPrimaryCls = "px-4 py-2 text-sm font-medium text-primary-foreground bg-primary rounded-lg shadow-sm hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-ring transition-colors active:scale-[0.98]";
const btnSecondaryCls = "px-4 py-2 text-sm font-medium text-secondary-foreground bg-secondary rounded-lg hover:bg-accent focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-ring transition-colors active:scale-[0.98]";

export function SettingsModals({
  modals,
  messages,
  onClose,
}: SettingsModalsProps) {
  // Contexts
  const {
    modelConfig,
    setModelConfig,
    models,
    modelOptions,
    error,
    selectedDevices,
    setSelectedDevices,
    selectedLanguage,
    setSelectedLanguage,
    transcriptModelConfig,
    setTranscriptModelConfig,
    showConfidenceIndicator,
    toggleConfidenceIndicator,
  } = useConfig();

  const { isRecording } = useRecordingState();

  return <>
    {/* Legacy Settings Modal */}
    {modals.modelSettings && (
      <div className={`${overlayCls} p-4`}>
        <div className={`${cardCls} max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col`}>
          {/* Header */}
          <div className="flex justify-between items-center p-6 border-b border-border">
            <h3 className="text-xl font-semibold tracking-tight text-foreground">Preferences</h3>
            <button
              onClick={() => onClose("modelSettings")}
              className={closeBtnCls}
              aria-label="Закрыть"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Content - Scrollable */}
          <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-8">
            {/* General Preferences Section */}
            <PreferenceSettings />

            {/* Divider */}
            <div className="border-t border-border pt-8">
              <h4 className="text-lg font-semibold text-foreground mb-4">AI Model Configuration</h4>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-muted-foreground mb-1">
                    Summarization Model
                  </label>
                  <div className="flex space-x-2">
                    <select
                      className={selectCls}
                      value={modelConfig.provider}
                      onChange={(e) => {
                        const provider = e.target.value as ModelConfig['provider'];
                        setModelConfig({
                          ...modelConfig,
                          provider,
                          model: modelOptions[provider][0]
                        });
                      }}
                    >
                      <option value="builtin-ai">Built-in AI</option>
                      <option value="claude">Claude</option>
                      <option value="groq">Groq</option>
                      <option value="ollama">Ollama</option>
                      <option value="openrouter">OpenRouter</option>
                      <option value="openai">OpenAI</option>
                    </select>

                    <select
                      className={`${selectCls} flex-1`}
                      value={modelConfig.model}
                      onChange={(e) => setModelConfig((prev: ModelConfig) => ({ ...prev, model: e.target.value }))}
                    >
                      {modelOptions[modelConfig.provider].map((model: string) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                {modelConfig.provider === 'ollama' && (
                  <div>
                    <h4 className="text-lg font-bold text-foreground mb-4">Available Ollama Models</h4>
                    {error && (
                      <div className="bg-destructive/10 border border-destructive/40 text-destructive px-4 py-3 rounded-lg mb-4">
                        {error}
                      </div>
                    )}
                    <div className="grid gap-4 max-h-[400px] overflow-y-auto custom-scrollbar pr-2">
                      {models.map((model) => (
                        <div
                          key={model.id}
                          className={`p-4 rounded-lg border cursor-pointer transition-colors ${modelConfig.model === model.name
                            ? 'ring-2 ring-primary border-primary bg-accent'
                            : 'bg-card border-border hover:bg-secondary'
                            }`}
                          onClick={() => setModelConfig((prev: ModelConfig) => ({ ...prev, model: model.name }))}
                        >
                          <h3 className="font-bold text-foreground">{model.name}</h3>
                          <p className="text-muted-foreground">Size: {model.size}</p>
                          <p className="text-muted-foreground">Modified: {model.modified}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="border-t border-border p-6 flex justify-end">
            <button
              onClick={() => onClose('modelSettings')}
              className={btnPrimaryCls}
            >
              Done
            </button>
          </div>
        </div>
      </div>
    )}

    {/* Device Settings Modal */}
    {modals.deviceSettings && (
      <div className={overlayCls}>
        <div className={`${cardCls} p-6 max-w-md w-full mx-4`}>
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-semibold text-foreground">Audio Device Settings</h3>
            <button
              onClick={() => onClose('deviceSettings')}
              className={closeBtnCls}
              aria-label="Закрыть"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <DeviceSelection
            selectedDevices={selectedDevices}
            onDeviceChange={setSelectedDevices}
            disabled={isRecording}
          />

          <div className="mt-6 flex justify-end">
            <button
              onClick={() => {
                const micDevice = selectedDevices.micDevice || 'Default';
                const systemDevice = selectedDevices.systemDevice || 'Default';
                toast.success("Devices selected", {
                  description: `Microphone: ${micDevice}, System Audio: ${systemDevice}`,
                  className: "bg-card text-card-foreground border border-border",
                });
                onClose('deviceSettings');
              }}
              className={btnPrimaryCls}
            >
              Done
            </button>
          </div>
        </div>
      </div>
    )}

    {/* Language Settings Modal */}
    {modals.languageSettings && (
      <div className={overlayCls}>
        <div className={`${cardCls} p-6 max-w-md w-full mx-4`}>
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-semibold text-foreground">Language Settings</h3>
            <button
              onClick={() => onClose('languageSettings')}
              className={closeBtnCls}
              aria-label="Закрыть"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <LanguageSelection
            selectedLanguage={selectedLanguage}
            onLanguageChange={setSelectedLanguage}
            disabled={isRecording}
            provider={transcriptModelConfig.provider}
          />

          <div className="mt-6 flex justify-end">
            <button
              onClick={() => onClose('languageSettings')}
              className={btnPrimaryCls}
            >
              Done
            </button>
          </div>
        </div>
      </div>
    )}

    {/* Model Selection Modal */}
    {modals.modelSelector && (
      <div className={overlayCls}>
        <div className={`${cardCls} max-w-4xl w-full mx-4 max-h-[90vh] flex flex-col`}>
          {/* Fixed Header */}
          <div className="flex justify-between items-center p-6 pb-4 border-b border-border">
            <h3 className="text-lg font-semibold text-foreground">
              {messages.modelSelector ? 'Speech Recognition Setup Required' : 'Transcription Model Settings'}
            </h3>
            <button
              onClick={() => onClose('modelSelector')}
              className={closeBtnCls}
              aria-label="Закрыть"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Scrollable Content */}
          <div className="flex-1 overflow-y-auto custom-scrollbar p-6 pt-4">
            <TranscriptSettings
              transcriptModelConfig={transcriptModelConfig}
              setTranscriptModelConfig={setTranscriptModelConfig}
              onModelSelect={() => onClose('modelSelector')}
            />
          </div>

          {/* Fixed Footer */}
          <div className="p-6 pt-4 border-t border-border flex items-center justify-between">
            {/* Confidence Indicator Toggle */}
            <div className="flex items-center gap-3">
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={showConfidenceIndicator}
                  onChange={(e) => toggleConfidenceIndicator(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-border peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-ring rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-border after:border after:rounded-full after:h-5 after:w-5 after:shadow after:transition-all peer-checked:bg-primary"></div>
              </label>
              <div>
                <p className="text-sm font-medium text-foreground">Show Confidence Indicators</p>
                <p className="text-xs text-muted-foreground">Display colored dots showing transcription confidence quality</p>
              </div>
            </div>

            <button
              onClick={() => onClose('modelSelector')}
              className={btnSecondaryCls}
            >
              {messages.modelSelector ? 'Cancel' : 'Done'}
            </button>
          </div>
        </div>
      </div>
    )}

    {/* Error Alert Modal */}
    {modals.errorAlert && (
      <div className={overlayCls}>
        <Alert className="max-w-md mx-4 border-destructive/40 bg-card shadow-2xl rounded-2xl">
          <AlertTitle className="text-destructive">Recording Stopped</AlertTitle>
          <AlertDescription className="text-foreground/80">
            {messages.errorAlert}
            <button
              onClick={() => onClose('errorAlert')}
              className="ml-2 text-destructive hover:text-destructive/80 underline"
            >
              Dismiss
            </button>
          </AlertDescription>
        </Alert>
      </div>
    )}

    {/* Chunk Drop Warning Modal */}
    {modals.chunkDropWarning && (
      <div className={overlayCls}>
        <Alert className="max-w-lg mx-4 border-amber-500/40 bg-card shadow-2xl rounded-2xl">
          <AlertTitle className="text-amber-600 dark:text-amber-400">Transcription Performance Warning</AlertTitle>
          <AlertDescription className="text-foreground/80">
            {messages.chunkDropWarning}
            <button
              onClick={() => onClose('chunkDropWarning')}
              className="ml-2 text-amber-600 dark:text-amber-400 hover:opacity-80 underline"
            >
              Dismiss
            </button>
          </AlertDescription>
        </Alert>
      </div>
    )}
  </>
}

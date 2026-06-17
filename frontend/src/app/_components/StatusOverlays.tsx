interface StatusOverlaysProps {
  // Status flags
  isProcessing: boolean;      // Processing transcription after recording stops
  isSaving: boolean;          // Saving transcript to database
  isUploading?: boolean;      // Отправка на сервер Insapp

  // Layout
  sidebarCollapsed: boolean;  // For responsive margin calculation
}

// Internal reusable component for individual status overlays
interface StatusOverlayProps {
  show: boolean;
  message: string;
  sidebarCollapsed: boolean;
  variant?: 'default' | 'cloud';
}

function StatusOverlay({ show, message, sidebarCollapsed, variant = 'default' }: StatusOverlayProps) {
  if (!show) return null;

  return (
    <div className="fixed bottom-4 left-0 right-0 z-10">
      <div
        className="flex justify-center pl-8 transition-[margin] duration-300"
        style={{
          marginLeft: sidebarCollapsed ? '4rem' : '16rem'
        }}
      >
        <div className="w-2/3 max-w-[750px] flex justify-center">
          <div className="bg-card rounded-lg shadow-lg px-4 py-2 flex items-center space-x-2">
            <div
              className={`animate-spin rounded-full h-4 w-4 border-b-2 ${
                variant === 'cloud' ? 'border-blue-600' : 'border-gray-900'
              }`}
            />
            <span className="text-sm text-foreground">{message}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// Main exported component - renders multiple status overlays
export function StatusOverlays({
  isProcessing,
  isSaving,
  isUploading = false,
  sidebarCollapsed
}: StatusOverlaysProps) {
  return (
    <>
      {/* Processing status overlay - shown after recording stops while finalizing transcription */}
      <StatusOverlay
        show={isProcessing}
        message="Завершаю распознавание..."
        sidebarCollapsed={sidebarCollapsed}
      />

      {/* Saving status overlay - shown while saving transcript to database */}
      <StatusOverlay
        show={isSaving && !isUploading}
        message="Сохраняю транскрипт..."
        sidebarCollapsed={sidebarCollapsed}
      />

      {/* Upload to Insapp server overlay */}
      <StatusOverlay
        show={isUploading}
        message="Отправляю на сервер Insapp..."
        sidebarCollapsed={sidebarCollapsed}
        variant="cloud"
      />
    </>
  );
}

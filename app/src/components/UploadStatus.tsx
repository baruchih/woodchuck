import { useEffect, useRef, useState, useCallback } from 'react';

export interface UploadState {
  uploading: boolean;
  result: { type: 'success' | 'error'; message: string } | null;
}

interface UploadStatusProps {
  state: UploadState;
  compact?: boolean;
}

export function UploadStatus({ state, compact }: UploadStatusProps) {
  if (!state.uploading && !state.result) return null;

  const textSize = compact ? 'text-[10px]' : 'text-xs';

  if (state.uploading) {
    return (
      <div className={`flex items-center gap-1.5 px-2 py-1 ${textSize}`}>
        <Spinner compact={compact} />
        <span className="text-text-muted">Uploading...</span>
      </div>
    );
  }

  if (state.result) {
    const color = state.result.type === 'success' ? 'text-primary' : 'text-status-error';
    return (
      <div className={`flex items-center gap-1.5 px-2 py-1 ${textSize} ${color} upload-result-fade`}>
        {state.result.type === 'success' ? (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={compact ? 'w-3 h-3' : 'w-3.5 h-3.5'}>
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={compact ? 'w-3 h-3' : 'w-3.5 h-3.5'}>
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
        )}
        <span>{state.result.message}</span>
      </div>
    );
  }

  return null;
}

function Spinner({ compact }: { compact?: boolean }) {
  const size = compact ? 'w-3 h-3' : 'w-3.5 h-3.5';
  return (
    <svg className={`${size} animate-spin text-primary`} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

/** Hook to manage upload status state with auto-clearing result */
export function useUploadStatus(): {
  uploadStatus: UploadState;
  setUploading: (v: boolean) => void;
  setUploadResult: (type: 'success' | 'error', message: string) => void;
  clearResult: () => void;
} {
  const [uploadStatus, setUploadStatus] = useState<UploadState>({
    uploading: false,
    result: null,
  });
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  const setUploading = useCallback((v: boolean) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setUploadStatus({ uploading: v, result: null });
  }, []);

  const setUploadResult = useCallback((type: 'success' | 'error', message: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setUploadStatus({ uploading: false, result: { type, message } });
    timerRef.current = setTimeout(() => {
      setUploadStatus({ uploading: false, result: null });
    }, 3000);
  }, []);

  const clearResult = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setUploadStatus({ uploading: false, result: null });
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { uploadStatus, setUploading, setUploadResult, clearResult };
}

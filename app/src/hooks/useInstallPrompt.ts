import { useState, useEffect, useCallback } from 'react';
import type { BeforeInstallPromptEvent } from '../types';

interface UseInstallPromptReturn {
  canInstall: boolean;
  install: () => Promise<void>;
}

export function useInstallPrompt(): UseInstallPromptReturn {
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    const handleBeforeInstall = (e: Event) => {
      e.preventDefault();
      setPrompt(e as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setInstalled(true);
      setPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    window.addEventListener('appinstalled', handleAppInstalled);

    // Check if already installed (standalone mode)
    if (window.matchMedia('(display-mode: standalone)').matches) {
      setInstalled(true);
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!prompt) return;

    prompt.prompt();
    const result = await prompt.userChoice;

    if (result.outcome === 'accepted') {
      setInstalled(true);
    }
    setPrompt(null);
  }, [prompt]);

  return {
    canInstall: !!prompt && !installed,
    install,
  };
}

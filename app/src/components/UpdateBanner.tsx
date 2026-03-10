import { useUpdateChecker } from '../hooks/useUpdateChecker';

export function UpdateBanner() {
  const { updateAvailable, applyUpdate } = useUpdateChecker();

  if (!updateAvailable) return null;

  return (
    <div
      className="fixed top-0 left-0 right-0 z-50 bg-primary text-background text-center py-2 px-4 cursor-pointer text-sm font-medium"
      onClick={applyUpdate}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') applyUpdate();
      }}
    >
      Update available — tap to reload
    </div>
  );
}

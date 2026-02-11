import { useWS } from '../context/WebSocketContext';

export function ConnectionStatus() {
  const { connected } = useWS();

  return (
    <div className="flex items-center gap-2">
      <div
        className={`w-2 h-2 rounded-full ${
          connected
            ? 'bg-primary glow text-primary'
            : 'bg-status-error animate-pulse-status text-status-error'
        }`}
      />
      {!connected && (
        <span className="text-xs text-status-error uppercase tracking-wider">offline</span>
      )}
    </div>
  );
}

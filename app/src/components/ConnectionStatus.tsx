import { useWS } from '../context/WebSocketContext';

export function ConnectionStatus() {
  const { connected, forceReconnect } = useWS();

  return (
    <div
      className={`flex items-center gap-2 ${!connected ? 'cursor-pointer' : ''}`}
      onClick={!connected ? forceReconnect : undefined}
      role={!connected ? 'button' : undefined}
      title={!connected ? 'Tap to reconnect' : undefined}
    >
      <div
        className={`w-2 h-2 rounded-full ${
          connected
            ? 'bg-primary glow text-primary'
            : 'bg-status-error animate-pulse-status text-status-error'
        }`}
      />
      {!connected && (
        <span className="text-xs text-status-error uppercase tracking-wider">tap to reconnect</span>
      )}
    </div>
  );
}

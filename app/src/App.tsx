import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { WebSocketProvider } from './context/WebSocketContext';
import { usePushReregister } from './hooks/usePushReregister';
import { SessionsPage } from './pages/SessionsPage';
import { SessionPage } from './pages/SessionPage';
import { NewSessionPage } from './pages/NewSessionPage';
import { InsultSwordFightPage } from './pages/InsultSwordFightPage';
import { SettingsPage } from './pages/SettingsPage';

export function App() {
  // Re-register push subscription on app startup (handles server restart)
  usePushReregister();

  return (
    <BrowserRouter
      future={{
        v7_startTransition: true,
        v7_relativeSplatPath: true,
      }}
    >
      <WebSocketProvider>
        <Routes>
          <Route path="/" element={<SessionsPage />} />
          <Route path="/session/:id" element={<SessionPage />} />
          <Route path="/new" element={<NewSessionPage />} />
          <Route path="/insult-sword-fight" element={<InsultSwordFightPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </WebSocketProvider>
    </BrowserRouter>
  );
}

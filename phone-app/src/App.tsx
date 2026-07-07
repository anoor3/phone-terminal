import { useCallback, useRef, useState } from 'react';
import { ClaimPage } from './ClaimPage';
import { CodePage } from './CodePage';
import { ConnectedPage } from './ConnectedPage';
import { DisconnectedPage } from './DisconnectedPage';

type AppState = 'claim' | 'code' | 'connected' | 'disconnected';

export function App() {
  const [state, setState] = useState<AppState>('claim');
  const [disconnectReason, setDisconnectReason] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [pairingId, setPairingId] = useState('');
  const [initialCode, setInitialCode] = useState('');
  const wsRef = useRef<WebSocket | null>(null);

  const handleClaimed = useCallback((ws: WebSocket, id: string, code: string) => {
    wsRef.current = ws;
    setPairingId(id);
    setInitialCode(code);
    setState('code');
  }, []);

  const handlePaired = useCallback((sid: string) => {
    setSessionId(sid);
    setState('connected');
  }, []);

  const handleDisconnected = useCallback((reason: string) => {
    setDisconnectReason(reason);
    setState('disconnected');
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  switch (state) {
    case 'claim':
      return <ClaimPage onClaimed={handleClaimed} />;
    case 'code':
      return (
        <CodePage
          ws={wsRef.current!}
          pairingId={pairingId}
          initialCode={initialCode}
          onPaired={handlePaired}
        />
      );
    case 'connected':
      return (
        <ConnectedPage
          ws={wsRef.current!}
          sessionId={sessionId}
          onDisconnected={handleDisconnected}
        />
      );
    case 'disconnected':
      return <DisconnectedPage reason={disconnectReason} />;
  }
}

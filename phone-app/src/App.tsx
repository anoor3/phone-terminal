import { useState } from 'react';

type AppState = 'claim' | 'code' | 'connected' | 'disconnected';

function ClaimPage({ onNext }: { onNext: () => void }) {
  return (
    <div>
      <h1>Claim Session</h1>
      <p>Scan the QR code displayed on your laptop to claim the session.</p>
      <button onClick={onNext}>Next (placeholder)</button>
    </div>
  );
}

function CodePage({ onNext }: { onNext: () => void }) {
  return (
    <div>
      <h1>Verification Code</h1>
      <p>Enter the verification code shown on your laptop.</p>
      <button onClick={onNext}>Verify (placeholder)</button>
    </div>
  );
}

function ConnectedPage({ onDisconnect }: { onDisconnect: () => void }) {
  return (
    <div>
      <h1>Connected</h1>
      <p>Terminal session active. Type commands below.</p>
      <button onClick={onDisconnect}>Disconnect (placeholder)</button>
    </div>
  );
}

function DisconnectedPage({ onReconnect }: { onReconnect: () => void }) {
  return (
    <div>
      <h1>Disconnected</h1>
      <p>Session ended.</p>
      <button onClick={onReconnect}>Reconnect (placeholder)</button>
    </div>
  );
}

export function App() {
  const [state, setState] = useState<AppState>('claim');

  switch (state) {
    case 'claim':
      return <ClaimPage onNext={() => setState('code')} />;
    case 'code':
      return <CodePage onNext={() => setState('connected')} />;
    case 'connected':
      return <ConnectedPage onDisconnect={() => setState('disconnected')} />;
    case 'disconnected':
      return <DisconnectedPage onReconnect={() => setState('claim')} />;
  }
}

import { useEffect } from 'react';
import { clearKeypair } from './crypto';

interface DisconnectedPageProps {
  reason: string;
}

export function DisconnectedPage({ reason }: DisconnectedPageProps) {
  useEffect(() => {
    // Clean up keypair from IndexedDB on disconnect
    void clearKeypair();
  }, []);

  return (
    <div
      style={{
        padding: '2rem',
        textAlign: 'center',
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#fff5f5',
      }}
    >
      <div
        style={{
          width: '80px',
          height: '80px',
          borderRadius: '50%',
          background: '#fed7d7',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '2rem',
          marginBottom: '1.5rem',
        }}
      >
        🔴
      </div>

      <h1 style={{ color: '#e53e3e', marginBottom: '0.5rem', fontSize: '1.5rem' }}>
        Disconnected
      </h1>

      <p style={{ color: '#4a5568', marginBottom: '0.5rem', fontSize: '1.1rem' }}>
        Session ended: {reason}
      </p>

      <p style={{ color: '#718096', marginBottom: '2rem' }}>
        This session has ended
      </p>

      <p style={{ color: '#a0aec0', fontStyle: 'italic' }}>
        Go back to your laptop to reconnect
      </p>
    </div>
  );
}

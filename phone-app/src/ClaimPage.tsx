import { useEffect, useState } from 'react';
import { generateKeypair } from './crypto';

// WSS only — no ws:// code path exists (per §10)
const WS_URL = import.meta.env.VITE_WS_URL ?? `wss://${window.location.host}/ws`;

interface ClaimPageProps {
  onClaimed: (ws: WebSocket, pairingId: string) => void;
}

export function ClaimPage({ onClaimed }: ClaimPageProps) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Extract pairingId from pathname: /p/{pairingId}
    const pathParts = window.location.pathname.split('/');
    const pIdx = pathParts.indexOf('p');
    const pairingId = pIdx !== -1 ? pathParts[pIdx + 1] : undefined;

    // Extract pairingToken from URL fragment (never sent to server in HTTP)
    const pairingToken = window.location.hash.slice(1); // remove leading '#'

    if (!pairingId || !pairingToken) {
      setError('Invalid pairing link. Missing pairing ID or token.');
      setLoading(false);
      return;
    }

    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'phone_claim',
        pairingId,
        pairingToken,
      }));
    };

    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data as string) as { type: string; error?: string; code?: string };

      if (msg.type === 'phone_claim_ack') {
        // Generate ECDSA keypair on successful claim
        await generateKeypair();
        // Don't transition yet — wait for code_challenge so we don't miss it
      } else if (msg.type === 'code_challenge') {
        // Code arrived — now transition with the code included
        onClaimed(ws, pairingId);
      } else if (msg.type === 'error') {
        setError(msg.error ?? 'Pairing failed. Token may be expired or already claimed.');
        setLoading(false);
        ws.close();
      }
    };

    ws.onerror = () => {
      setError('Connection failed. Unable to reach server.');
      setLoading(false);
    };

    ws.onclose = (event) => {
      if (!event.wasClean && loading) {
        setError('Connection closed unexpectedly.');
        setLoading(false);
      }
    };

    return () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center' }}>
        <div style={{ fontSize: '2rem', marginBottom: '1rem' }}>⚠️</div>
        <h1 style={{ color: '#e53e3e', marginBottom: '0.5rem' }}>Pairing Failed</h1>
        <p style={{ color: '#666' }}>{error}</p>
      </div>
    );
  }

  return (
    <div style={{ padding: '2rem', textAlign: 'center' }}>
      <div
        style={{
          width: '48px',
          height: '48px',
          border: '4px solid #e2e8f0',
          borderTopColor: '#3182ce',
          borderRadius: '50%',
          margin: '2rem auto',
          animation: 'spin 1s linear infinite',
        }}
        role="status"
        aria-label="Connecting"
      />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <h1 style={{ marginBottom: '0.5rem' }}>Connecting…</h1>
      <p style={{ color: '#666' }}>Pairing with your laptop</p>
    </div>
  );
}

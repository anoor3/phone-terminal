import { useEffect, useState } from 'react';
import { generateKeypair, exportPublicKeyJWK } from './crypto';

// WSS only — no ws:// code path exists (per §10)
const WS_URL = import.meta.env.VITE_WS_URL ?? `wss://${window.location.host}/ws`;

interface ClaimPageProps {
  onClaimed: (ws: WebSocket, pairingId: string, code: string) => void;
  onPaired: (ws: WebSocket, sessionId: string) => void;
}

export function ClaimPage({ onClaimed, onPaired }: ClaimPageProps) {
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('Connecting...');

  useEffect(() => {
    const pathParts = window.location.pathname.split('/');
    const pIdx = pathParts.indexOf('p');
    const pairingId = pIdx !== -1 ? pathParts[pIdx + 1] : undefined;
    const pairingToken = window.location.hash.slice(1);

    if (!pairingId || !pairingToken) {
      setError('Invalid pairing link. Missing pairing ID or token.');
      return;
    }

    const ws = new WebSocket(WS_URL);
    let claimed = false;
    let code = '';

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'phone_claim', pairingId, pairingToken }));
    };

    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data as string) as Record<string, unknown>;
      const type = msg['type'] as string;

      if (type === 'phone_claim_ack') {
        setStatus('Generating keys...');
        const kp = await generateKeypair();
        // Send public key to backend for signature verification
        const pubKey = await exportPublicKeyJWK(kp);
        ws.send(JSON.stringify({ type: 'public_key', pairingId, publicKeyJwk: pubKey }));
        setStatus('Waiting for verification code...');
        claimed = true;
      } else if (type === 'code_challenge') {
        code = msg['code'] as string ?? '';
        if (claimed) {
          onClaimed(ws, pairingId, code);
        }
      } else if (type === 'code_valid' || type === 'paired') {
        // If paired event arrives while still on this page, handle it
        const sessionId = msg['sessionId'] as string ?? '';
        onPaired(ws, sessionId);
      } else if (type === 'error') {
        setError(msg['error'] as string ?? 'Pairing failed.');
        ws.close();
      }
    };

    ws.onerror = () => {
      setError('Connection failed. Unable to reach server.');
    };

    ws.onclose = () => {
      if (!claimed) {
        setError('Connection closed unexpectedly.');
      }
    };

    return () => {
      // Don't close WS on unmount — it's being passed to the next page
    };
  }, [onClaimed, onPaired]);

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
          width: '48px', height: '48px',
          border: '4px solid #e2e8f0', borderTopColor: '#3182ce',
          borderRadius: '50%', margin: '2rem auto',
          animation: 'spin 1s linear infinite',
        }}
      />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <h1 style={{ marginBottom: '0.5rem' }}>{status}</h1>
    </div>
  );
}

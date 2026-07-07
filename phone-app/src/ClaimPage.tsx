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
    let ready = false; // keypair generated + public key sent
    let bufferedCode = ''; // buffer code if it arrives before ready
    let transitioned = false;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'phone_claim', pairingId, pairingToken }));
    };

    ws.onmessage = async (event) => {
      if (transitioned) return;
      const msg = JSON.parse(event.data as string) as Record<string, unknown>;
      const type = msg['type'] as string;

      if (type === 'phone_claim_ack') {
        setStatus('Generating keys...');
        const kp = await generateKeypair();
        const pubKey = await exportPublicKeyJWK(kp);
        ws.send(JSON.stringify({ type: 'public_key', pairingId, publicKeyJwk: pubKey }));
        ready = true;
        // If code arrived while we were generating keys, use it now
        if (bufferedCode) {
          transitioned = true;
          onClaimed(ws, pairingId, bufferedCode);
        } else {
          setStatus('Waiting for code...');
        }
      } else if (type === 'code_challenge') {
        const code = msg['code'] as string ?? '';
        if (ready) {
          transitioned = true;
          onClaimed(ws, pairingId, code);
        } else {
          // Buffer it — will be used once keypair is ready
          bufferedCode = code;
        }
      } else if (type === 'code_valid' || type === 'paired') {
        transitioned = true;
        onPaired(ws, msg['sessionId'] as string ?? '');
      } else if (type === 'error') {
        setError(msg['error'] as string ?? 'Pairing failed.');
        ws.close();
      }
    };

    ws.onerror = () => setError('Connection failed.');
    ws.onclose = () => { if (!ready && !transitioned) setError('Connection closed.'); };

    return () => {};
  }, [onClaimed, onPaired]);

  if (error) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center' }}>
        <div style={{ fontSize: '2rem', marginBottom: '1rem' }}>⚠️</div>
        <h1 style={{ color: '#e53e3e' }}>Pairing Failed</h1>
        <p style={{ color: '#666' }}>{error}</p>
      </div>
    );
  }

  return (
    <div style={{ padding: '2rem', textAlign: 'center' }}>
      <div style={{
        width: '48px', height: '48px',
        border: '4px solid #e2e8f0', borderTopColor: '#3182ce',
        borderRadius: '50%', margin: '2rem auto',
        animation: 'spin 1s linear infinite',
      }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <h1>{status}</h1>
    </div>
  );
}

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
  const [needsPairingLink, setNeedsPairingLink] = useState(false);
  const [status, setStatus] = useState('Connecting...');

  useEffect(() => {
    const pathParts = window.location.pathname.split('/');
    const pIdx = pathParts.indexOf('p');
    const pairingId = pIdx !== -1 ? pathParts[pIdx + 1] : undefined;
    const pairingToken = window.location.hash.slice(1);

    if (!pairingId || !pairingToken) {
      setNeedsPairingLink(true);
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
      } else if (type === 'code_valid') {
        setStatus('Code accepted. Connecting...');
      } else if (type === 'paired') {
        const sessionId = msg['sessionId'];
        if (typeof sessionId !== 'string' || !sessionId) {
          setError('Pairing completed without a session. Run connect again.');
          ws.close();
          return;
        }
        transitioned = true;
        onPaired(ws, sessionId);
      } else if (type === 'error') {
        setError(msg['error'] as string ?? 'Pairing failed.');
        ws.close();
      }
    };

    ws.onerror = () => setError('Connection failed.');
    ws.onclose = () => { if (!ready && !transitioned) setError('Connection closed.'); };

    return () => {};
  }, [onClaimed, onPaired]);

  if (needsPairingLink) {
    return (
      <div style={{
        minHeight: '100dvh',
        padding: 'max(2rem, env(safe-area-inset-top)) 1.5rem max(2rem, env(safe-area-inset-bottom))',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#070b10',
        color: '#dbe5ee',
        textAlign: 'center',
        fontFamily: 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}>
        <div style={{
          width: '4.5rem',
          height: '4.5rem',
          borderRadius: '1.25rem',
          border: '1px solid #223044',
          background: '#0d131b',
          display: 'grid',
          placeItems: 'center',
          marginBottom: '1.25rem',
          boxShadow: '0 22px 60px rgba(0, 0, 0, 0.35)',
        }}>
          <span style={{
            color: '#22c55e',
            fontFamily: '"SFMono-Regular", "Cascadia Code", "Roboto Mono", Menlo, Consolas, monospace',
            fontSize: '2rem',
            fontWeight: 800,
          }}>
            &gt;_
          </span>
        </div>
        <h1 style={{
          margin: 0,
          color: '#f3f8ff',
          fontSize: '1.45rem',
          lineHeight: 1.15,
        }}>
          Ready to pair
        </h1>
        <p style={{
          maxWidth: '22rem',
          margin: '0.8rem 0 0',
          color: '#8fa3b8',
          fontSize: '0.98rem',
          lineHeight: 1.45,
        }}>
          Start `phone-terminal connect` on your laptop, then scan the QR code with this phone.
        </p>
        <div style={{
          width: 'min(100%, 23rem)',
          marginTop: '1.4rem',
          padding: '1rem',
          border: '1px solid #223044',
          borderRadius: '0.85rem',
          background: '#0d131b',
          textAlign: 'left',
        }}>
          <div style={{
            color: '#f3f8ff',
            fontSize: '0.92rem',
            fontWeight: 800,
            marginBottom: '0.55rem',
          }}>
            Want an app-like shortcut?
          </div>
          <ol style={{
            margin: 0,
            paddingLeft: '1.15rem',
            color: '#a8b8c8',
            fontSize: '0.86rem',
            lineHeight: 1.55,
          }}>
            <li>Open this page in Safari.</li>
            <li>Tap Share.</li>
            <li>Tap Add to Home Screen.</li>
          </ol>
        </div>
      </div>
    );
  }

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

import { useEffect, useState, useRef } from 'react';
import './CodePage.css';

interface CodePageProps {
  ws: WebSocket;
  pairingId: string;
  initialCode: string;
  onPaired: (sessionId: string) => void;
}

export function CodePage({ ws, pairingId: _pairingId, initialCode, onPaired }: CodePageProps) {
  const [code, setCode] = useState<string | null>(initialCode || null);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(120);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Start countdown timer immediately if we have a code
    if (code) {
      timerRef.current = setInterval(() => {
        setSecondsLeft((prev) => {
          if (prev <= 1) {
            if (timerRef.current) clearInterval(timerRef.current);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [code]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const msg = JSON.parse(event.data as string) as {
        type: string;
        code?: string;
        sessionId?: string;
        error?: string;
      };

      switch (msg.type) {
        case 'code_challenge':
          setCode(msg.code ?? '');
          break;
        case 'code_valid':
          if (timerRef.current) clearInterval(timerRef.current);
          break;
        case 'paired':
          if (timerRef.current) clearInterval(timerRef.current);
          if (msg.sessionId) {
            onPaired(msg.sessionId);
          } else {
            setError('Pairing completed without a session. Run connect again.');
          }
          break;
        case 'code_locked':
          if (timerRef.current) clearInterval(timerRef.current);
          setError(msg.error ?? 'Too many attempts. Session invalidated.');
          break;
      }
    };

    ws.addEventListener('message', handleMessage);

    return () => {
      ws.removeEventListener('message', handleMessage);
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, onPaired]);

  if (error) {
    return (
      <div className="code-page">
        <div className="code-panel">
          <div className="code-error-icon">!</div>
          <h1 className="code-title">Session Locked</h1>
          <p className="code-copy">{error}</p>
        </div>
      </div>
    );
  }

  if (!code) {
    return (
      <div className="code-page">
        <div className="code-panel">
          <div className="code-spinner" role="status" aria-label="Waiting for code" />
          <h1 className="code-title">Preparing Secure Pairing</h1>
          <p className="code-copy">Generating a one-time verification code.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="code-page">
      <div className="code-panel">
        <div className="code-status">
          <span className="code-status-dot" aria-hidden="true" />
          Pairing Active
        </div>

        <h1 className="code-title">Enter This Code</h1>
        <div className="verification-code" aria-label={`Verification code: ${code.split('').join(' ')}`}>
          {code.slice(0, 3)} {code.slice(3)}
        </div>

        <p className="code-copy">Type this into your laptop terminal.</p>
        <p className={`code-time ${secondsLeft <= 30 ? 'is-expiring' : ''}`}>
          Expires in {secondsLeft}s
        </p>
      </div>
    </div>
  );
}

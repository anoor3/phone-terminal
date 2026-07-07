import { useEffect, useState, useRef } from 'react';

interface CodePageProps {
  ws: WebSocket;
  pairingId: string;
  onPaired: (sessionId: string) => void;
}

export function CodePage({ ws, pairingId: _pairingId, onPaired }: CodePageProps) {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(120);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
          // Start countdown timer
          timerRef.current = setInterval(() => {
            setSecondsLeft((prev) => {
              if (prev <= 1) {
                if (timerRef.current) clearInterval(timerRef.current);
                return 0;
              }
              return prev - 1;
            });
          }, 1000);
          break;
        case 'code_valid':
        case 'paired':
          if (timerRef.current) clearInterval(timerRef.current);
          onPaired(msg.sessionId ?? '');
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
      <div style={{ padding: '2rem', textAlign: 'center' }}>
        <div style={{ fontSize: '2rem', marginBottom: '1rem' }}>🔒</div>
        <h1 style={{ color: '#e53e3e', marginBottom: '0.5rem' }}>Session Locked</h1>
        <p style={{ color: '#666' }}>{error}</p>
      </div>
    );
  }

  if (!code) {
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
          aria-label="Waiting for code"
        />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <p style={{ color: '#666' }}>Waiting for verification code…</p>
      </div>
    );
  }

  // Calculate progress for visual ring (0 to 1)
  const progress = secondsLeft / 120;
  const circumference = 2 * Math.PI * 54; // radius = 54
  const strokeDashoffset = circumference * (1 - progress);

  return (
    <div style={{ padding: '2rem', textAlign: 'center' }}>
      {/* Countdown ring */}
      <div style={{ position: 'relative', width: '120px', height: '120px', margin: '1rem auto' }}>
        <svg width="120" height="120" viewBox="0 0 120 120" aria-hidden="true">
          <circle
            cx="60"
            cy="60"
            r="54"
            fill="none"
            stroke="#e2e8f0"
            strokeWidth="6"
          />
          <circle
            cx="60"
            cy="60"
            r="54"
            fill="none"
            stroke={secondsLeft > 30 ? '#3182ce' : '#e53e3e'}
            strokeWidth="6"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            transform="rotate(-90 60 60)"
            style={{ transition: 'stroke-dashoffset 1s linear' }}
          />
        </svg>
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            fontSize: '1.25rem',
            fontWeight: 'bold',
            color: secondsLeft > 30 ? '#2d3748' : '#e53e3e',
          }}
        >
          {secondsLeft}s
        </div>
      </div>

      {/* 6-digit code display */}
      <div
        style={{
          fontSize: '48px',
          fontWeight: 'bold',
          letterSpacing: '0.3em',
          fontFamily: 'monospace',
          margin: '1.5rem 0',
          color: '#1a202c',
        }}
        aria-label={`Verification code: ${code.split('').join(' ')}`}
      >
        {code}
      </div>

      <p style={{ color: '#4a5568', fontSize: '1.1rem' }}>
        Type this code into your terminal
      </p>
    </div>
  );
}

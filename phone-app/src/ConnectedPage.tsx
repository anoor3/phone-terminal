import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { clearKeypair, getKeypair, sign } from './crypto';

interface ConnectedPageProps {
  ws: WebSocket;
  sessionId: string;
  onDisconnected: (reason: string) => void;
}

export function ConnectedPage({ ws, sessionId, onDisconnected }: ConnectedPageProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const seqRef = useRef(0);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('Connected');
  const [hostname] = useState(() => {
    // Extract hostname from WS URL or use a default
    try {
      const url = new URL(ws.url);
      return url.hostname;
    } catch {
      return 'laptop';
    }
  });

  useEffect(() => {
    if (!terminalRef.current) return;

    const term = new Terminal({
      cursorBlink: false,
      disableStdin: true,
      convertEol: true,
      fontFamily: '"SFMono-Regular", "Cascadia Code", "Roboto Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.35,
      scrollback: 3000,
      theme: {
        background: '#0b0f14',
        foreground: '#d6deeb',
        cursor: '#8bd5ff',
        selectionBackground: '#2d4f67',
        black: '#011627',
        red: '#ef5350',
        green: '#22c55e',
        yellow: '#facc15',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#2dd4bf',
        white: '#d6deeb',
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddonRef.current = fitAddon;
    window.setTimeout(() => fitAddon.fit(), 0);
    termRef.current = term;
    term.writeln('\x1b[38;5;81mphone-terminal\x1b[0m session ready');

    const handleResize = () => fitAddon.fit();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      fitAddonRef.current = null;
      term.dispose();
    };
  }, []);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(event.data as string) as Record<string, unknown>;
      } catch {
        return;
      }

      switch (msg.type) {
        case 'output':
          if (msg['sessionId'] === sessionId && typeof msg['chunk'] === 'string' && termRef.current) {
            termRef.current.write(msg['chunk']);
            setStatus('Streaming output');
          }
          break;
        case 'status':
          if (msg['sessionId'] === sessionId && typeof msg['state'] === 'string') {
            setStatus(msg['state'].replace(/_/g, ' '));
          }
          break;
        case 'disconnect':
        case 'disconnected':
          void clearKeypair();
          onDisconnected(typeof msg.reason === 'string' ? msg.reason : 'Session ended by host');
          break;
        case 'error':
          if (typeof msg['error'] === 'string') setStatus(msg['error']);
          break;
      }
    };

    ws.addEventListener('message', handleMessage);

    return () => {
      ws.removeEventListener('message', handleMessage);
    };
  }, [ws, sessionId, onDisconnected]);

  const sendEnvelope = async (type: string, payload: unknown) => {
    const keypair = await getKeypair();
    if (!keypair) {
      setStatus('Missing signing key');
      return false;
    }

    const seq = ++seqRef.current;
    const ts = Date.now();
    const sig = await sign(keypair, sessionId, seq, ts, type, payload);

    ws.send(JSON.stringify({
      type,
      sessionId,
      seq,
      ts,
      payload,
      sig,
    }));

    return true;
  };

  const sendCommand = async (command: string) => {
    const payload = command + '\n'; // Add newline so command executes
    termRef.current?.writeln(`\x1b[38;5;244m$ ${command}\x1b[0m`);
    setStatus('Command sent');
    await sendEnvelope('input', payload);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    void sendCommand(input);
    setInput('');
  };

  const handleDisconnect = async () => {
    await sendEnvelope('disconnect', '');
    await clearKeypair();
    onDisconnected('Manual disconnect');
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        minHeight: '100vh',
        background: '#080c10',
        color: '#d6deeb',
        fontFamily: 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      <div
        style={{
          background: '#0f1720',
          borderBottom: '1px solid #1f2a37',
          padding: '0.7rem 0.9rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.75rem',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span
              aria-hidden="true"
              style={{
                width: '0.6rem',
                height: '0.6rem',
                borderRadius: '999px',
                background: '#22c55e',
                boxShadow: '0 0 14px rgba(34, 197, 94, 0.65)',
                flex: '0 0 auto',
              }}
            />
            <strong style={{ fontSize: '0.95rem', whiteSpace: 'nowrap' }}>Connected</strong>
          </div>
          <div
            style={{
              marginTop: '0.15rem',
              color: '#8ea3b7',
              fontFamily: '"SFMono-Regular", Menlo, Consolas, monospace',
              fontSize: '0.75rem',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: '70vw',
            }}
          >
            {hostname} / {sessionId.slice(0, 10)}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', flex: '0 0 auto' }}>
          <span
            style={{
              color: '#8ea3b7',
              fontSize: '0.78rem',
              textTransform: 'capitalize',
              maxWidth: '8rem',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {status}
          </span>
          <button
            onClick={() => termRef.current?.clear()}
            style={{
              background: '#162231',
              color: '#d6deeb',
              border: '1px solid #273549',
              borderRadius: '6px',
              padding: '0.45rem 0.65rem',
              fontWeight: 700,
              fontSize: '0.78rem',
              cursor: 'pointer',
            }}
            type="button"
          >
            Clear
          </button>
          <button
            onClick={() => void handleDisconnect()}
            style={{
              background: '#2a1117',
              color: '#ffb4bf',
              border: '1px solid #5f1f2b',
              borderRadius: '6px',
              padding: '0.45rem 0.65rem',
              fontWeight: 700,
              fontSize: '0.78rem',
              cursor: 'pointer',
            }}
            type="button"
          >
            Disconnect
          </button>
        </div>
      </div>

      <div
        ref={terminalRef}
        style={{
          flex: 1,
          minHeight: 0,
          background: '#0b0f14',
          padding: '0.75rem',
          overflow: 'hidden',
        }}
      />

      <form
        onSubmit={handleSubmit}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.6rem',
          borderTop: '1px solid #1f2a37',
          background: '#0f1720',
          padding: '0.65rem',
          paddingBottom: 'max(0.65rem, env(safe-area-inset-bottom))',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            color: '#22c55e',
            fontFamily: '"SFMono-Regular", Menlo, Consolas, monospace',
            fontSize: '1rem',
            flex: '0 0 auto',
          }}
        >
          $
        </span>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Enter command…"
          autoFocus
          style={{
            flex: 1,
            minWidth: 0,
            padding: '0.75rem 0.85rem',
            border: '1px solid #273549',
            borderRadius: '6px',
            outline: 'none',
            background: '#0b0f14',
            color: '#e5edf5',
            fontSize: '1rem',
            fontFamily: '"SFMono-Regular", "Cascadia Code", "Roboto Mono", Menlo, Consolas, monospace',
          }}
          aria-label="Command input"
        />
        <button
          type="submit"
          style={{
            padding: '0.75rem 1rem',
            background: '#1f6feb',
            color: '#ffffff',
            border: '1px solid #2f81f7',
            borderRadius: '6px',
            fontWeight: 800,
            fontSize: '0.9rem',
            cursor: 'pointer',
            flex: '0 0 auto',
          }}
        >
          Send
        </button>
      </form>
    </div>
  );
}

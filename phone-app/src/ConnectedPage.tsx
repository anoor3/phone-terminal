import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { getKeypair, sign } from './crypto';

interface ConnectedPageProps {
  ws: WebSocket;
  sessionId: string;
  onDisconnected: (reason: string) => void;
}

export function ConnectedPage({ ws, sessionId, onDisconnected }: ConnectedPageProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const seqRef = useRef(0);
  const [input, setInput] = useState('');
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
      fontSize: 14,
      theme: {
        background: '#1a202c',
        foreground: '#e2e8f0',
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddon.fit();
    termRef.current = term;

    const handleResize = () => fitAddon.fit();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      term.dispose();
    };
  }, []);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const msg = JSON.parse(event.data as string) as {
        type: string;
        data?: string;
        reason?: string;
      };

      switch (msg.type) {
        case 'output':
          if (msg.data && termRef.current) {
            termRef.current.write(msg.data);
          }
          break;
        case 'disconnect':
        case 'disconnected':
          onDisconnected(msg.reason ?? 'Session ended by host');
          break;
      }
    };

    ws.addEventListener('message', handleMessage);

    return () => {
      ws.removeEventListener('message', handleMessage);
    };
  }, [ws, onDisconnected]);

  const sendCommand = async (command: string) => {
    const keypair = await getKeypair();
    if (!keypair) return;

    const seq = ++seqRef.current;
    const ts = Date.now();
    const type = 'input';
    const signature = await sign(keypair, sessionId, seq, ts, type, command);

    ws.send(JSON.stringify({
      type,
      sessionId,
      seq,
      ts,
      payload: command,
      signature,
    }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    void sendCommand(input);
    setInput('');
  };

  const handleDisconnect = async () => {
    const keypair = await getKeypair();
    if (!keypair) return;

    const seq = ++seqRef.current;
    const ts = Date.now();
    const type = 'disconnect';
    const signature = await sign(keypair, sessionId, seq, ts, type, '');

    ws.send(JSON.stringify({
      type,
      sessionId,
      seq,
      ts,
      payload: '',
      signature,
    }));

    onDisconnected('Manual disconnect');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Green connected banner */}
      <div
        style={{
          background: '#38a169',
          color: '#fff',
          padding: '0.75rem 1rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span style={{ fontWeight: 'bold' }}>
          🟢 Connected to {hostname}
        </span>
        <button
          onClick={() => void handleDisconnect()}
          style={{
            background: '#fff',
            color: '#e53e3e',
            border: 'none',
            borderRadius: '4px',
            padding: '0.4rem 0.75rem',
            fontWeight: 'bold',
            cursor: 'pointer',
          }}
        >
          Disconnect
        </button>
      </div>

      {/* Terminal output area */}
      <div
        ref={terminalRef}
        style={{ flex: 1, background: '#1a202c', padding: '0.5rem' }}
      />

      {/* Input bar */}
      <form
        onSubmit={handleSubmit}
        style={{
          display: 'flex',
          borderTop: '1px solid #e2e8f0',
          background: '#fff',
        }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Enter command…"
          autoFocus
          style={{
            flex: 1,
            padding: '0.75rem 1rem',
            border: 'none',
            outline: 'none',
            fontSize: '1rem',
            fontFamily: 'monospace',
          }}
          aria-label="Command input"
        />
        <button
          type="submit"
          style={{
            padding: '0.75rem 1.5rem',
            background: '#3182ce',
            color: '#fff',
            border: 'none',
            fontWeight: 'bold',
            cursor: 'pointer',
          }}
        >
          Send
        </button>
      </form>
    </div>
  );
}

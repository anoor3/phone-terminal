import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './ConnectedPage.css';
import { clearKeypair, getKeypair, sign } from './crypto';

interface ConnectedPageProps {
  ws: WebSocket;
  sessionId: string;
  onDisconnected: (reason: string) => void;
}

interface TerminalSize {
  cols: number;
  rows: number;
}

type InputMode = 'chat' | 'raw';

const CONTROL_KEYS = [
  { label: 'Ctrl+C', payload: '\x03' },
  { label: 'Esc', payload: '\x1b' },
  { label: 'Tab', payload: '\t' },
  { label: 'Up', payload: '\x1b[A' },
  { label: 'Down', payload: '\x1b[B' },
  { label: 'Left', payload: '\x1b[D' },
  { label: 'Right', payload: '\x1b[C' },
  { label: 'Ctrl+D', payload: '\x04' },
];

export function ConnectedPage({ ws, sessionId, onDisconnected }: ConnectedPageProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const seqRef = useRef(0);
  const sendQueueRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const lastSizeRef = useRef<TerminalSize | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyboardOpenRef = useRef(false);
  const [input, setInput] = useState('');
  const [livePreview, setLivePreview] = useState('');
  const [status, setStatus] = useState('Connected');
  const [focusMode, setFocusMode] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [inputMode, setInputMode] = useState<InputMode>('chat');
  const [hostname] = useState(() => {
    try {
      const url = new URL(ws.url);
      return url.hostname;
    } catch {
      return 'laptop';
    }
  });

  const sendEnvelope = useCallback((type: string, payload: unknown) => {
    const task = sendQueueRef.current.then(async () => {
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
    });

    sendQueueRef.current = task.catch(() => false);
    return task;
  }, [sessionId, ws]);

  const syncTerminalSize = useCallback(() => {
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon) return;
    if (keyboardOpenRef.current) return;

    fitAddon.fit();
    const nextSize = { cols: term.cols, rows: term.rows };
    const previousSize = lastSizeRef.current;
    if (
      nextSize.cols < 2 ||
      nextSize.rows < 2 ||
      (previousSize?.cols === nextSize.cols && previousSize?.rows === nextSize.rows)
    ) {
      return;
    }

    lastSizeRef.current = nextSize;
    void sendEnvelope('resize', nextSize);
  }, [sendEnvelope]);

  const scheduleResize = useCallback(() => {
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = setTimeout(syncTerminalSize, 80);
  }, [syncTerminalSize]);

  const syncVisualViewport = useCallback(() => {
    const shell = shellRef.current;
    const viewport = window.visualViewport;
    const layoutHeight = window.innerHeight;
    const visualHeight = viewport?.height ?? layoutHeight;
    keyboardOpenRef.current = visualHeight < layoutHeight - 120;

    if (shell) {
      shell.style.setProperty('--visual-height', `${visualHeight}px`);
      shell.style.setProperty('--visual-offset-top', `${viewport?.offsetTop ?? 0}px`);
    }

    if (!keyboardOpenRef.current) {
      scheduleResize();
    }
  }, [scheduleResize]);

  useEffect(() => {
    if (!terminalRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      disableStdin: true,
      convertEol: true,
      fontFamily: '"SFMono-Regular", "Cascadia Code", "Roboto Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.32,
      scrollback: 5000,
      theme: {
        background: '#090d12',
        foreground: '#dbe5ee',
        cursor: '#93c5fd',
        selectionBackground: '#284763',
        black: '#0b0f14',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#eab308',
        blue: '#3b82f6',
        magenta: '#a855f7',
        cyan: '#14b8a6',
        white: '#dbe5ee',
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    termRef.current = term;
    fitAddonRef.current = fitAddon;
    term.writeln('\x1b[38;5;81mphone-terminal\x1b[0m session ready');
    scheduleResize();

    const resizeObserver = new ResizeObserver(scheduleResize);
    resizeObserver.observe(terminalRef.current);
    syncVisualViewport();
    window.addEventListener('resize', syncVisualViewport);
    window.addEventListener('orientationchange', syncVisualViewport);
    window.visualViewport?.addEventListener('resize', syncVisualViewport);
    window.visualViewport?.addEventListener('scroll', syncVisualViewport);

    return () => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeObserver.disconnect();
      window.removeEventListener('resize', syncVisualViewport);
      window.removeEventListener('orientationchange', syncVisualViewport);
      window.visualViewport?.removeEventListener('resize', syncVisualViewport);
      window.visualViewport?.removeEventListener('scroll', syncVisualViewport);
      fitAddonRef.current = null;
      termRef.current = null;
      term.dispose();
    };
  }, [scheduleResize, syncVisualViewport]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setFocusMode(document.fullscreenElement === shellRef.current);
      scheduleResize();
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, [scheduleResize]);

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
            setStatus('Streaming');
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
    return () => ws.removeEventListener('message', handleMessage);
  }, [ws, sessionId, onDisconnected]);

  const sendInput = useCallback(async (payload: string, label = 'Sent') => {
    const sent = await sendEnvelope('input', payload);
    if (sent) setStatus(label);
  }, [sendEnvelope]);

  const refocusInput = useCallback(() => {
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const sendSpecialInput = useCallback((payload: string, label: string) => {
    void sendInput(payload, label);
    refocusInput();
  }, [refocusInput, sendInput]);

  const handleRecoverTerminal = async () => {
    setInput('');
    setLivePreview('');
    setInputMode('chat');
    setStatus('Recovering');
    termRef.current?.reset();
    scheduleResize();

    // Ctrl+C interrupts the active foreground app. Ctrl+U clears any partial
    // shell line if we are already back at a prompt.
    await sendInput('\x03', 'Recover');
    await sendInput('\x15', 'Recover');
    refocusInput();
  };

  const sendCommand = async (command: string) => {
    await sendInput(`${command}\r`, 'Command sent');
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputMode === 'raw') {
      setLivePreview('');
      void sendInput('\r', 'Enter');
      return;
    }
    if (!input.trim()) return;
    void sendCommand(input);
    setInput('');
    requestAnimationFrame(() => {
      terminalRef.current?.scrollIntoView({ block: 'nearest' });
    });
  };

  const handleDisconnect = async () => {
    await sendEnvelope('disconnect', '');
    await clearKeypair();
    onDisconnected('Manual disconnect');
  };

  const toggleFocusMode = async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
      setFocusMode(false);
      scheduleResize();
      return;
    }

    setFocusMode(true);
    await shellRef.current?.requestFullscreen?.().catch(() => undefined);
    scheduleResize();
  };

  const handleLiveKeysChange = (nextValue: string) => {
    if (inputMode === 'chat') {
      setInput(nextValue);
      return;
    }

    if (nextValue.length > livePreview.length) {
      const inserted = nextValue.slice(livePreview.length);
      setLivePreview(nextValue);
      void sendInput(inserted, 'Live Keys');
      return;
    }

    if (nextValue.length < livePreview.length) {
      const deletedCount = livePreview.length - nextValue.length;
      setLivePreview(nextValue);
      void sendInput('\x7f'.repeat(deletedCount), 'Backspace');
      return;
    }

    setLivePreview(nextValue);
  };

  const handleRawKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (inputMode !== 'raw') return;

    const keyPayloads: Record<string, string> = {
      Enter: '\r',
      Backspace: '\x7f',
      Escape: '\x1b',
      Tab: '\t',
      ArrowUp: '\x1b[A',
      ArrowDown: '\x1b[B',
      ArrowRight: '\x1b[C',
      ArrowLeft: '\x1b[D',
    };

    if (e.ctrlKey && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      setLivePreview('');
      void sendInput('\x03', 'Ctrl+C');
      return;
    }

    const payload = keyPayloads[e.key];
    if (payload) {
      e.preventDefault();
      if (e.key === 'Enter') setLivePreview('');
      if (e.key === 'Backspace') setLivePreview((current) => current.slice(0, -1));
      void sendInput(payload, e.key);
    }
  };

  const handleRawPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    if (inputMode !== 'raw') return;
    const pasted = e.clipboardData.getData('text');
    if (!pasted) return;
    e.preventDefault();
    setLivePreview(pasted.slice(-48));
    void sendInput(pasted, 'Paste');
  };

  return (
    <div ref={shellRef} className={`terminal-shell${focusMode ? ' focus-mode' : ''}`}>
      <header className="terminal-header">
        <div className="connection-meta">
          <div className="connection-title">
            <span className="status-dot" aria-hidden="true" />
            <span>Connected</span>
          </div>
          <div className="session-meta" title={`${hostname} / ${sessionId}`}>
            {hostname} / {sessionId.slice(0, 10)}
          </div>
        </div>

        <div className="header-actions">
          <span className="status-label">{status}</span>
          <button
            className="icon-button"
            onClick={() => termRef.current?.clear()}
            type="button"
            aria-label="Clear terminal"
            title="Clear terminal"
          >
            CLR
          </button>
          <button
            className="icon-button fullscreen-button"
            onClick={() => void toggleFocusMode()}
            type="button"
            aria-label={focusMode ? 'Exit fullscreen' : 'Open fullscreen'}
            title={focusMode ? 'Exit fullscreen' : 'Open fullscreen'}
          >
            <span className="fullscreen-icon" aria-hidden="true" />
          </button>
          <button
            className="disconnect-button"
            onClick={() => void handleDisconnect()}
            type="button"
          >
            Disconnect
          </button>
        </div>
      </header>

      <main className="terminal-stage">
        <div ref={terminalRef} className="terminal-canvas" />
      </main>

      <section className="composer-panel" aria-label="Command composer">
        <div className="mode-toggle" role="tablist" aria-label="Input mode">
          <button
            className={`mode-option${inputMode === 'chat' ? ' active' : ''}`}
            type="button"
            onClick={() => {
              setInputMode('chat');
              setLivePreview('');
            }}
            role="tab"
            aria-selected={inputMode === 'chat'}
          >
            Command
          </button>
          <button
            className={`mode-option${inputMode === 'raw' ? ' active' : ''}`}
            type="button"
            onClick={() => {
              setInput('');
              setLivePreview('');
              setInputMode('raw');
              refocusInput();
            }}
            role="tab"
            aria-selected={inputMode === 'raw'}
          >
            Live Keys
          </button>
        </div>
        <div className="mode-hint">
          {inputMode === 'raw'
            ? 'Live Keys sends each key as you type. Use this for Codex, Vim, Nano, and other interactive apps.'
            : 'Command mode sends the whole line when you tap Send.'}
        </div>

        <div className="composer-actions">
          <button
            className="quick-action danger-action"
            type="button"
            onClick={() => sendSpecialInput('\x03', 'Ctrl+C')}
          >
            Ctrl+C
          </button>
          <button
            className="quick-action recover-action"
            type="button"
            onClick={() => void handleRecoverTerminal()}
          >
            Recover
          </button>
          <button
            className="quick-action"
            type="button"
            onClick={() => setControlsOpen((open) => !open)}
            aria-expanded={controlsOpen}
          >
            {controlsOpen ? 'Hide Keys' : 'Keys'}
          </button>
          <button
            className="quick-action"
            type="button"
            onClick={() => termRef.current?.clear()}
          >
            Clear
          </button>
        </div>

        {controlsOpen && (
          <div className="terminal-controls" aria-label="Terminal control keys">
            {CONTROL_KEYS.filter((key) => key.label !== 'Ctrl+C').map((key) => (
              <button
                key={key.label}
                className="control-key"
                type="button"
                onClick={() => sendSpecialInput(key.payload, key.label)}
              >
                {key.label}
              </button>
            ))}
          </div>
        )}

        <form className="command-form" onSubmit={handleSubmit}>
          <span className="prompt-marker" aria-hidden="true">$</span>
          <input
            ref={inputRef}
            type="text"
            value={inputMode === 'raw' ? livePreview : input}
            onKeyDown={handleRawKeyDown}
            onPaste={handleRawPaste}
            onChange={(e) => handleLiveKeysChange(e.target.value)}
            placeholder={inputMode === 'raw' ? 'Live Keys: type here...' : 'Type a command...'}
            autoFocus
            className="command-input"
            aria-label="Command input"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <button type="submit" className="send-button">
            {inputMode === 'raw' ? 'Enter' : 'Send'}
          </button>
        </form>
      </section>
    </div>
  );
}

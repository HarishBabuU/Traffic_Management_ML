import { useEffect, useRef, useMemo, useState } from 'react';
import StatusBadge from './StatusBadge';
import { ASSISTANT_MODE } from '../services/aiAssistant';
import {
  createVoiceAssistantService,
  VOICE_STATE,
} from '../services/voiceAssistant';

const STARTER_PROMPTS = [
  'Plan a trip from Chennai to Madurai',
  'Show my current route',
  "What's the weather?",
  'Which route are you recommending?',
  'Show CCTV for route 2',
  'Help me investigate CCTV',
];

const INITIAL_HELP =
  'Hello — I am the local operations assistant for the command centre. Tell me an origin and destination ' +
  '(e.g. "route from Chennai to Madurai"), ask about the current route, the live weather, CCTV ' +
  'investigation, the historical evidence ("show evidence") or the reasoning view ("open intelligence"). ' +
  'Mode: LOCAL ASSISTANT (no external AI provider connected).';

/**
 * Command Centre — floating assistant drawer.
 *
 * Available from anywhere via the floating launcher. The control-centre state
 * is NOT duplicated here and the voice service never parses commands: a
 * recognized transcript is forwarded exactly once through the existing
 * `onProcess` callback (createAssistantService → App actions). The drawer is
 * purely a presentation layer on top of the unchanged Part 4 assistant.
 */
export default function AIAssistantSection({ onProcess, voiceService, open = false, onClose }) {
  const listRef = useRef(null);
  const voice = useRef(voiceService || createVoiceAssistantService());
  const voiceInstance = voice.current;

  const [messages, setMessages] = useState(() => [
    { id: 'a0', role: 'assistant', text: INITIAL_HELP },
  ]);
  const [input, setInput] = useState('');
  const [voiceState, setVoiceState] = useState(voiceInstance.state);
  const [voiceError, setVoiceError] = useState('');
  const [recognizedText, setRecognizedText] = useState('');
  const [speakEnabled, setSpeakEnabled] = useState(
    voiceInstance.supported.speechSynthesis
  );

  const idRef = useRef(1);
  const onProcessRef = useRef(onProcess);
  const speakEnabledRef = useRef(speakEnabled);
  const lastTranscriptRef = useRef('');

  useEffect(() => {
    onProcessRef.current = onProcess;
  }, [onProcess]);

  useEffect(() => {
    speakEnabledRef.current = speakEnabled;
  }, [speakEnabled]);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    const unsubscribe = voiceInstance.subscribe({
      onState: (state) => setVoiceState(state),
      onTranscript: (transcript) => {
        const trimmed = String(transcript || '').trim();
        if (!trimmed || lastTranscriptRef.current === trimmed) return;
        lastTranscriptRef.current = trimmed;
        setRecognizedText(transcript);
        sendMessage(transcript);
      },
      onError: (message) => setVoiceError(message),
    });
    return () => {
      // Unmount: stop any recognizer and any speech synthesis so no mic or
      // speaker is left behind when the assistant goes away.
      lastTranscriptRef.current = '';
      setRecognizedText('');
      try {
        voiceInstance.stop();
      } catch (error) {
        // ignore: cleanup is best-effort
      }
      try {
        voiceInstance.cancelSpeech();
      } catch (error) {
        // ignore: cleanup is best-effort
      }
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceInstance]);

  // Closing the drawer stops listening and cancels any spoken reply so the
  // mic never lingers after the drawer is hidden.
  useEffect(() => {
    if (open) return undefined;
    voiceInstance.stop();
    voiceInstance.cancelSpeech();
    lastTranscriptRef.current = '';
    setRecognizedText('');
    return undefined;
  }, [open, voiceInstance]);

  const sendMessage = (raw) => {
    const text = String(raw || '').trim();
    if (!text) return;
    const userMsg = { id: `u${idRef.current++}`, role: 'user', text };
    setMessages((prev) => [...prev, userMsg]);
    const result =
      typeof onProcessRef.current === 'function' ? onProcessRef.current(text) : null;
    const replyText =
      result && result.reply
        ? result.reply
        : 'The local assistant could not produce a reply right now.';
    const assistantMsg = { id: `a${idRef.current++}`, role: 'assistant', text: replyText };
    setMessages((prev) => [...prev, assistantMsg]);
    setInput('');
    if (speakEnabledRef.current) {
      voiceInstance.speak(replyText);
    }
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    sendMessage(input);
  };

  const handleToggleListening = () => {
    setVoiceError('');
    setRecognizedText('');
    if (voiceState === VOICE_STATE.LISTENING) {
      voiceInstance.stop();
    } else {
      lastTranscriptRef.current = '';
      voiceInstance.start();
    }
  };

  const handleToggleSpeak = () => {
    if (!voiceInstance.supported.speechSynthesis) return;
    const next = !speakEnabled;
    setSpeakEnabled(next);
    if (!next) {
      voiceInstance.cancelSpeech();
    }
  };

  const clearConversation = () => {
    setMessages([{ id: 'a0', role: 'assistant', text: INITIAL_HELP }]);
    setInput('');
    setRecognizedText('');
    lastTranscriptRef.current = '';
  };

  const listening = voiceState === VOICE_STATE.LISTENING;
  const micUsable = voiceInstance.supported.recognition;

  const voiceSummary = useMemo(() => {
    if (voiceState === VOICE_STATE.LISTENING) return 'Listening for a command…';
    if (voiceState === VOICE_STATE.PROCESSING) return 'Sending the command to the assistant…';
    if (voiceState === VOICE_STATE.SPEAKING) return 'Speaking the reply…';
    if (voiceState === VOICE_STATE.ERROR) return 'Voice hit a problem. Text chat still works.';
    if (voiceState === VOICE_STATE.UNAVAILABLE) return 'Voice is unavailable. Use text chat below.';
    return 'Tap Start Voice, speak a command, and it is sent straight to the assistant.';
  }, [voiceState]);

  const messagesList = useMemo(
    () =>
      messages.map((msg) => (
        <li
          key={msg.id}
          className={`assistant-msg${
            msg.role === 'user' ? ' assistant-msg-user' : ' assistant-msg-bot'
          }`}
        >
          <span className="assistant-msg-role">{msg.role === 'user' ? 'You' : 'Assistant'}</span>
          <span className="assistant-msg-text">{msg.text}</span>
        </li>
      )),
    [messages]
  );

  return (
    <div className={`assistant-layer assistant-layer-${open ? 'open' : 'closed'}`} data-voice-state={voiceState}>
      <button
        type="button"
        className="assistant-fab"
        aria-expanded={open}
        aria-controls="assistant-drawer"
        aria-label={open ? 'Close the AI assistant' : 'Open the AI assistant'}
        title="Traffic Operations Assistant"
        onClick={() => (onClose ? onClose(!open) : undefined)}
      >
        <span className="assistant-fab-icon" aria-hidden="true">{open ? '✕' : '✦'}</span>
        {!open ? <span className="assistant-fab-label">Assistant</span> : null}
      </button>

      <aside
        id="assistant-drawer"
        className="assistant-drawer"
        role="dialog"
        aria-label="AI Assistant"
        aria-hidden={!open}
      >
        <header className="assistant-drawer-head">
          <div className="assistant-header-title-wrap">
            <span className="assistant-header-sparkle" aria-hidden="true">✦</span>
            <div>
              <h3>AI Assistant</h3>
              <span className="assistant-header-sub">Local operations agent</span>
            </div>
          </div>
          <div className="assistant-drawer-head-actions">
            <StatusBadge status="LOCAL" note={ASSISTANT_MODE.label} />
            <button
              type="button"
              className="btn btn-ghost btn-sm assistant-close-btn"
              aria-label="Close assistant"
              onClick={() => onClose(false)}
            >
              ✕
            </button>
          </div>
        </header>

        <div className="voice-compact-bar" aria-live="polite">
          <button
            type="button"
            className={listening ? 'btn btn-danger btn-sm' : 'btn btn-ghost btn-sm voice-toggle-btn'}
            onClick={handleToggleListening}
            disabled={!micUsable && !listening}
            aria-label={listening ? 'Stop listening' : 'Start voice command'}
            title={
              micUsable
                ? undefined
                : 'Speech recognition is not supported in this browser. You can use text chat.'
            }
          >
            {listening ? 'Stop Listening' : 'Start Voice'}
          </button>

          <label
            className={`voice-toggle-compact${voiceInstance.supported.speechSynthesis ? '' : ' voice-toggle-disabled'}`}
            title={
              voiceInstance.supported.speechSynthesis
                ? 'Speak responses aloud'
                : 'Speech output not supported in browser'
            }
          >
            <input
              type="checkbox"
              checked={speakEnabled}
              onChange={handleToggleSpeak}
              disabled={!voiceInstance.supported.speechSynthesis}
            />
            <span>Speak responses</span>
          </label>

          <button type="button" className="btn btn-ghost btn-sm clear-chat-btn" onClick={clearConversation}>
            Clear
          </button>
        </div>

        {listening ? (
          <div className="voice-listening-active-bar" aria-live="polite">
            <div className="voice-pulse-indicator" aria-hidden="true">
              <span className="pulse-ring"></span>
              <span className="pulse-core">🎙️</span>
            </div>
            <div className="voice-listening-text">
              <strong>Listening…</strong>
              <span>Speak your command</span>
            </div>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={handleToggleListening}
              aria-label="Stop listening"
            >
              Stop Listening
            </button>
          </div>
        ) : null}

        {recognizedText ? (
          <div className="voice-transcript-banner" aria-live="polite">
            <span className="transcript-label">Heard:</span>
            <q className="transcript-body">{recognizedText}</q>
          </div>
        ) : null}

        {voiceError ? (
          <div className="voice-error-banner" role="alert">
            <span>{voiceError}</span>
          </div>
        ) : null}

        <div className="assistant-chat">
          <ol className="assistant-messages" ref={listRef} role="log" aria-live="polite" aria-label="Assistant conversation">
            {messagesList}
          </ol>

          <div className="assistant-prompts" aria-label="Starter prompts">
            {STARTER_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                className="assistant-prompt-chip"
                onClick={() => sendMessage(prompt)}
              >
                {prompt}
              </button>
            ))}
          </div>

          <form className="assistant-input-row" onSubmit={handleSubmit} aria-label="Send a message to the assistant">
            <label className="sr-only" htmlFor="assistant-input">
              Message to assistant
            </label>
            <input
              id="assistant-input"
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask anything or enter a route…"
              autoComplete="off"
            />
            {micUsable ? (
              <>
                <span
                  className={`mic-orb${listening ? ' mic-orb-active' : ''}`}
                  aria-hidden="true"
                />
                <button
                  type="button"
                  className={`btn btn-ghost mic-action-btn${listening ? ' mic-active' : ''}`}
                  onClick={handleToggleListening}
                  aria-label={listening ? 'Stop listening' : 'Start voice command'}
                  title={listening ? 'Stop listening' : 'Speak command'}
                >
                  🎙️
                </button>
              </>
            ) : null}
            <button type="submit" className="btn btn-primary send-action-btn" disabled={!input.trim()}>
              Send
            </button>
          </form>
        </div>
      </aside>
    </div>
  );
}
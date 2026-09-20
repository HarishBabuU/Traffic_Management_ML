/**
 * Phase 9F-4 Part 5 — Voice assistant.
 *
 * DECISION: browser-native voice.
 *
 * Speech recognition (window.SpeechRecognition / webkitSpeechRecognition, default
 * language en-IN) and speech output (window.speechSynthesis + SpeechSynthesisUtterance)
 * fully cover this dashboard's short commands ("route from A to B", "what's the
 * weather?", "show the route"). An external audio API would only add a server-side
 * key, a proxy, and extra failure paths without materially improving a local,
 * deterministic assistant. So: BROWSER_NATIVE when available, UNAVAILABLE otherwise.
 * No API key is used, no backend is added, and everything keeps working without
 * configuration.
 *
 * The service is a thin voice-only layer. It NEVER parses commands, never touches
 * App state, and never re-implements assistant logic: a transcript is forwarded
 * exactly once through the existing onProcess channel.
 */

export const VOICE_MODE = {
  API: 'VOICE_API',
  BROWSER_NATIVE: 'VOICE_BROWSER_NATIVE',
  UNAVAILABLE: 'VOICE_UNAVAILABLE',
};

export const VOICE_STATE = {
  IDLE: 'IDLE',
  LISTENING: 'LISTENING',
  PROCESSING: 'PROCESSING',
  SPEAKING: 'SPEAKING',
  UNAVAILABLE: 'UNAVAILABLE',
  ERROR: 'ERROR',
};

export const VOICE_LABELS = {
  IDLE: 'VOICE READY',
  LISTENING: 'VOICE LISTENING',
  PROCESSING: 'VOICE PROCESSING',
  SPEAKING: 'VOICE SPEAKING',
  UNAVAILABLE: 'VOICE UNAVAILABLE',
  ERROR: 'VOICE ERROR',
};

export const VOICE_MODE_LABELS = {
  VOICE_API: 'VOICE API READY',
  VOICE_BROWSER_NATIVE: 'VOICE BROWSER FALLBACK',
  VOICE_UNAVAILABLE: 'VOICE UNAVAILABLE',
};

export const DEFAULT_LANGUAGE = 'en-IN';

/**
 * Ordered fallback chain used when a recognizer reports
 * `language-not-supported`: the current recognizer is replaced with one using
 * the next language in this list and restarted once, so a browser that cannot
 * build an en-IN recognizer still gets one attempt in en-US before surfacing
 * an error. The service default language stays en-IN.
 */
export const LANGUAGE_FALLBACKS = ['en-IN', 'en-US'];

const noop = () => {};

export function getRecognitionConstructor(win) {
  const target = win || (typeof window !== 'undefined' ? window : null);
  if (!target) return null;
  return target.SpeechRecognition || target.webkitSpeechRecognition || null;
}

export function getRecognitionApiName(win) {
  const target = win || (typeof window !== 'undefined' ? window : null);
  if (!target) return null;
  if (typeof target.SpeechRecognition !== 'undefined') return 'SpeechRecognition';
  if (typeof target.webkitSpeechRecognition !== 'undefined') return 'webkitSpeechRecognition';
  return null;
}

export function detectRecognitionSupport(win) {
  const api = getRecognitionApiName(win);
  return { supported: api !== null, api };
}

export function detectSpeechSynthesisSupport(win) {
  const target = win || (typeof window !== 'undefined' ? window : null);
  return {
    supported: !!(
      target &&
      typeof target.speechSynthesis !== 'undefined' &&
      typeof target.SpeechSynthesisUtterance !== 'undefined'
    ),
  };
}

export function detectVoiceMode(win) {
  const recognition = detectRecognitionSupport(win);
  const synthesis = detectSpeechSynthesisSupport(win);
  if (recognition.supported || synthesis.supported) return VOICE_MODE.BROWSER_NATIVE;
  return VOICE_MODE.UNAVAILABLE;
}

export function mapVoiceError(code) {
  const messages = {
    'not-allowed':
      'Microphone permission was denied. You can continue using text chat.',
    'permission-denied':
      'Microphone permission was denied. You can continue using text chat.',
    audio_capture:
      'No microphone was found. You can continue using text chat.',
    'audio-capture':
      'No microphone was found. You can continue using text chat.',
    'no-speech': 'No speech was detected. Please try again.',
    aborted: 'Listening was stopped.',
    network:
      'Speech recognition needs a connection and failed this time. You can continue using text chat.',
    'language-not-supported':
      'Your browser could not use the selected language for this voice. You can continue using text chat.',
    'service-not-allowed':
      'Speech recognition is not allowed in this browser context. You can continue using text chat.',
  };
  return (
    messages[code] ||
    'Voice is not available right now. You can continue using text chat.'
  );
}

export function createVoiceAssistantService(options = {}) {
  const win = options.window || (typeof window !== 'undefined' ? window : null);

  const recognitionCtor =
    options.recognitionCtor !== undefined
      ? options.recognitionCtor
      : getRecognitionConstructor(win);
  const speechSynthesis =
    options.speechSynthesis !== undefined ? options.speechSynthesis : win ? win.speechSynthesis : null;
  const utteranceCtor =
    options.utteranceCtor !== undefined
      ? options.utteranceCtor
      : win
        ? win.SpeechSynthesisUtterance
        : null;

  const language = options.language || DEFAULT_LANGUAGE;
  const onStateChange = options.onStateChange || noop;

  let listeners = {
    onState: noop,
    onTranscript: options.onTranscript || noop,
    onError: options.onError || noop,
  };

  let state = VOICE_STATE.IDLE;
  let activeRecognizer = null;
  let utterance = null;
  // Monotonic session id. Every listening session gets a fresh recognizer and a
  // fresh session id; late events from an old recognizer (onend / onerror /
  // onresult) are ignored so they can never sabotage a newer session.
  let sessionId = 0;
  let transcriptForwarded = false;
  let fallbackAttempt = 0;

  const setState = (next) => {
    if (state !== next) {
      state = next;
      onStateChange(state);
      listeners.onState(state);
    }
  };

  const setError = (message) => {
    if (listeners.onError) listeners.onError(message);
  };

  const supported = {
    recognition: recognitionCtor !== null,
    speechSynthesis: !!(speechSynthesis && utteranceCtor),
  };

  // Development diagnostics only: never part of the production UI. Enabled in
  // Vite dev (`import.meta.env.DEV` is statically replaced and tree-shaken from
  // production builds), by an explicit `debug: true` option, or from the
  // browser console with `window.__VOICE_DEBUG__ = true;` before the app boot.
  const isDevDiagnosticsEnabled =
    options.debug === true ||
    (typeof import.meta !== 'undefined' &&
      import.meta.env &&
      import.meta.env.DEV === true) ||
    (win && win.__VOICE_DEBUG__ === true);

  const voiceDebug = (...parts) => {
    if (!isDevDiagnosticsEnabled) return;
    try {
      const label = parts.shift();
      const sink = (win && win.console) || (typeof console !== 'undefined' ? console : null);
      if (sink && typeof sink.debug === 'function') sink.debug('[voice]', label, ...parts);
      else if (sink && typeof sink.log === 'function') sink.log('[voice]', label, ...parts);
    } catch (error) {
      // diagnostic logging must never break runtime behaviour
    }
  };

  const recognitionApiName = getRecognitionApiName(win);

  // Build a fresh recognizer for each listening session. IDL constructors
  // (window.SpeechRecognition / window.webkitSpeechRecognition) MUST be invoked
  // with `new`; calling them as plain functions throws "Illegal constructor" in
  // current Chromium, which surfaced to users as "The microphone could not be
  // started." Unit-test doubles are frequently plain functions (including arrow
  // functions) that reject `new`, so a plain call is kept as a fallback only.
  const buildRecognizer = () => {
    try {
      return new recognitionCtor();
    } catch {
      return recognitionCtor();
    }
  };

  const bindRecognizer = (lang = language) => {
    const rec = buildRecognizer();
    const mySession = sessionId;
    rec.lang = lang;
    rec.interimResults = false;
    rec.continuous = false;
    rec.maxAlternatives = 1;

    // Every handler is attached BEFORE recognition.start() is ever called.
    const isCurrent = () => mySession === sessionId && activeRecognizer === rec;

    rec.onstart = () => {
      if (!isCurrent()) return;
      voiceDebug('onstart fired', { lang: rec.lang, api: recognitionApiName });
    };

    rec.onresult = (event) => {
      if (!isCurrent()) return;
      const results = event && event.results;
      const slot = results && results[event.resultIndex];
      const final = slot && slot.isFinal;
      const transcript = final && slot[0] && slot[0].transcript;
      voiceDebug('onresult fired', { final: !!final, transcript: transcript || '' });
      if (!final || !transcript || transcriptForwarded) return;
      transcriptForwarded = true;
      setState(VOICE_STATE.PROCESSING);
      listeners.onTranscript(String(transcript).trim());
      // Only settle to IDLE if the forwarder did not already take over the
      // state (e.g. the reply is being spoken → SPEAKING). Without this, the
      // trailing IDLE would clobber SPEAKING and the UI would drop the
      // speech state immediately after every voice command.
      if (state === VOICE_STATE.PROCESSING) {
        setState(VOICE_STATE.IDLE);
      }
    };

    rec.onerror = (event) => {
      if (!isCurrent()) return;
      const code = event && event.error;
      voiceDebug('onerror fired', { error: code });
      // One automatic retry with the next language in LANGUAGE_FALLBACKS when
      // the browser rejects the currently selected recognizer language. The
      // retry is silent — only a second failure surfaces as an error.
      if (code === 'language-not-supported' && fallbackAttempt === 0) {
        const index = LANGUAGE_FALLBACKS.indexOf(language);
        if (index !== -1 && index + 1 < LANGUAGE_FALLBACKS.length) {
          fallbackAttempt += 1;
          transcriptForwarded = false;
          voiceDebug('language fallback retry', { next: LANGUAGE_FALLBACKS[index + 1] });
          try {
            sessionId += 1;
            const nextRec = bindRecognizer(LANGUAGE_FALLBACKS[index + 1]);
            activeRecognizer = nextRec;
            nextRec.start();
            return;
          } catch (error) {
            // fall through to the standard error handling below
          }
        }
      }
      if (code === 'aborted') {
        // The user or the browser intentionally stopped the session — that is
        // not a microphone failure and must not surface an error.
        voiceDebug('onerror code is aborted — intentional stop, not a failure');
        if (activeRecognizer === rec) activeRecognizer = null;
        if (state === VOICE_STATE.LISTENING || state === VOICE_STATE.PROCESSING) {
          setState(VOICE_STATE.IDLE);
        }
        return;
      }
      if (code === 'no-speech') {
        // The microphone started fine and simply heard nothing. Encourage the
        // user to listen again rather than reporting a microphone failure.
        setError('No speech was detected. Please tap the microphone and try again.');
        if (activeRecognizer === rec) activeRecognizer = null;
        if (state === VOICE_STATE.LISTENING || state === VOICE_STATE.PROCESSING) {
          setState(VOICE_STATE.IDLE);
        }
        return;
      }
      if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'permission-denied' || code === 'audio-capture' || code === 'audio_capture') {
        voiceDebug('permission or capture failure', { error: code });
      }
      setError(mapVoiceError(code));
      if (activeRecognizer === rec) activeRecognizer = null;
      setState(VOICE_STATE.ERROR);
    };

    rec.onnomatch = () => {
      if (!isCurrent()) return;
      voiceDebug('onnomatch fired');
      setError('No matching command was heard. Please try again.');
      if (state === VOICE_STATE.LISTENING || state === VOICE_STATE.PROCESSING) {
        setState(VOICE_STATE.IDLE);
      }
    };

    rec.onend = () => {
      if (!isCurrent()) return;
      voiceDebug('onend fired');
      if (activeRecognizer === rec) activeRecognizer = null;
      if (state === VOICE_STATE.LISTENING || state === VOICE_STATE.PROCESSING) {
        setState(VOICE_STATE.IDLE);
      }
    };

    return rec;
  };

  voiceDebug('service created', {
    recognitionApi: recognitionApiName,
    recognitionAvailable: supported.recognition,
    language,
    speechSynthesisAvailable: supported.speechSynthesis,
  });

  const cancelActiveSpeech = () => {
    if (speechSynthesis && typeof speechSynthesis.cancel === 'function') {
      try {
        speechSynthesis.cancel();
      } catch (error) {
        // ignore: cancelling is best-effort
      }
    }
    utterance = null;
  };

  return {
    get mode() {
      return detectVoiceMode(win);
    },
    get language() {
      return language;
    },
    get state() {
      return state;
    },
    get stateLabel() {
      return VOICE_LABELS[state] || state;
    },
    get modeLabel() {
      return VOICE_MODE_LABELS[this.mode] || this.mode;
    },
    get supported() {
      return supported;
    },

    subscribe(next) {
      listeners = { ...listeners, ...(next || {}) };
      return () => {
        listeners = { onState: noop, onTranscript: noop, onError: noop };
      };
    },

    start() {
      if (!supported.recognition) {
        setState(VOICE_STATE.UNAVAILABLE);
        setError(
          'Voice is not available in this browser. You can continue using text chat.'
        );
        return false;
      }
      if (state === VOICE_STATE.LISTENING) return false;
      // Never fight the spoken reply: stop any ongoing speech synthesis before
      // grabbing the microphone so the mic and the speaker do not overlap.
      if (state === VOICE_STATE.SPEAKING) {
        cancelActiveSpeech();
        setState(VOICE_STATE.IDLE);
      }
      transcriptForwarded = false;
      fallbackAttempt = 0;
      // A brand-new session id makes any still-in-flight recognizer from a
      // previous session harmless before this one starts.
      sessionId += 1;
      const mySession = sessionId;
      let rec;
      try {
        rec = bindRecognizer();
        activeRecognizer = rec;
        voiceDebug('start requested', {
          language: rec.lang,
          api: recognitionApiName,
          session: mySession,
        });
        rec.start();
      } catch (error) {
        if (mySession === sessionId) activeRecognizer = null;
        voiceDebug('recognizer.start() threw synchronously', {
          name: error && error.name,
          code: error && error.code,
          message: error && error.message,
        });
        setState(VOICE_STATE.ERROR);
        setError(
          'The microphone could not be started. You can continue using text chat.'
        );
        return false;
      }
      setState(VOICE_STATE.LISTENING);
      return true;
    },

    stop() {
      // Invalidate the current session first so no late events from its
      // recognizer can flip the state after we have explicitly stopped.
      sessionId += 1;
      const rec = activeRecognizer;
      activeRecognizer = null;
      if (rec) {
        try {
          if (typeof rec.abort === 'function') rec.abort();
          else rec.stop();
        } catch (error) {
          // ignore: stopping is best effort, the fallback timer cleans up
        }
      }
      if (state === VOICE_STATE.LISTENING) {
        setState(VOICE_STATE.IDLE);
      }
      return true;
    },

    speak(text) {
      const phrase = String(text || '').trim();
      if (!supported.speechSynthesis || !phrase) return false;
      try {
        if (speechSynthesis.cancel) speechSynthesis.cancel();
        const nextUtterance = new utteranceCtor(phrase);
        nextUtterance.lang = language;
        nextUtterance.onend = () => {
          utterance = null;
          if (state === VOICE_STATE.SPEAKING) setState(VOICE_STATE.IDLE);
        };
        nextUtterance.onerror = () => {
          utterance = null;
          if (state === VOICE_STATE.SPEAKING) setState(VOICE_STATE.IDLE);
        };
        utterance = nextUtterance;
        setState(VOICE_STATE.SPEAKING);
        speechSynthesis.speak(nextUtterance);
        return true;
      } catch (error) {
        utterance = null;
        setState(VOICE_STATE.IDLE);
        return false;
      }
    },

    cancelSpeech() {
      if (speechSynthesis && speechSynthesis.cancel) {
        try {
          speechSynthesis.cancel();
        } catch (error) {
          // ignore
        }
      }
      utterance = null;
      if (state === VOICE_STATE.SPEAKING) setState(VOICE_STATE.IDLE);
      return true;
    },
  };
}

export function defaultVoiceAssistantService() {
  return createVoiceAssistantService();
}
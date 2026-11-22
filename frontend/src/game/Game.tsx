import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FormEvent } from 'react';
import { ChallengeRecorder } from '../components/Camera/ChallengeRecorder';
import { SoloCameraPreview } from '../components/Camera/SoloCameraPreview';
import type { LiveFeedback, ReferenceClip } from '../types/challenge';
import { prepareReference } from '../utils/referenceRecorder';
import { checkBackend, importReference, scoreSoloAttempt, scoreRecovery } from './api';
import { ResultsReplay } from './ResultsReplay';
import { turnReducer } from './turn';
import '../components/Game/DashboardDanceFeedback.css';
import './game.css';

export default function Game({ onBack }: { onBack?: () => void }) {
  const [clip, setClip] = useState<ReferenceClip | null>(null);
  const [turn, dispatch] = useReducer(turnReducer, { stage: 'ready' });
  const [feedback, setFeedback] = useState<LiveFeedback | null>(null);
  const [cameraOverlay, setCameraOverlay] = useState<HTMLElement | null>(null);
  const attachCameraOverlay = useCallback((element: HTMLDivElement | null) => {
    setCameraOverlay(element?.querySelector<HTMLElement>('.challenge-recorder__camera') ?? null);
  }, []);
  const [preparing, setPreparing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState('');
  const [link, setLink] = useState('');
  const prepareOp = useRef<AbortController | null>(null);
  const clipUrl = useRef<string | null>(null);
  const turnId = useRef(0);

  useEffect(() => () => {
    prepareOp.current?.abort();
    if (clipUrl.current) URL.revokeObjectURL(clipUrl.current);
  }, []);

  useEffect(() => {
    if (!clip || turn.stage !== 'scoring') return;
    const controller = new AbortController();
    const deadline = AbortSignal.timeout(15_000);
    const signal = AbortSignal.any([controller.signal, deadline]);
    void scoreSoloAttempt(clip.recording, turn.attempt.recording, signal).then(
      score => {
        if (controller.signal.aborted) return;
        if (deadline.aborted) dispatch({ type: 'failed', key: turn.key, message: 'Scoring took too long. Retry the saved attempt.' });
        else dispatch({ type: 'scored', key: turn.key, score });
      },
      error => {
        if (controller.signal.aborted) return;
        const detail = deadline.aborted ? 'Scoring took too long. Retry the saved attempt.'
          : error instanceof Error ? error.message : 'Could not score the turn.';
        const recovery = scoreRecovery(error);
        if (recovery === 'reference') {
          if (clipUrl.current) URL.revokeObjectURL(clipUrl.current);
          clipUrl.current = null;
          setClip(null);
          dispatch({ type: 'reset' });
          setMessage(detail);
        } else if (recovery === 'attempt') {
          setFeedback(null);
          setMessage(detail);
          dispatch({ type: 'start', key: ++turnId.current });
        } else {
          dispatch({ type: 'failed', key: turn.key, message: detail });
        }
      },
    );
    return () => controller.abort();
  }, [clip, turn]);

  async function loadClip(source: (signal: AbortSignal) => Promise<Blob>) {
    prepareOp.current?.abort();
    const controller = new AbortController();
    prepareOp.current = controller;
    setMessage('');
    setPreparing(true);
    let url: string | undefined;
    try {
      const blob = await source(controller.signal);
      controller.signal.throwIfAborted();
      url = URL.createObjectURL(blob);
      const prepared = await prepareReference(url, controller.signal);
      controller.signal.throwIfAborted();
      if (clipUrl.current) URL.revokeObjectURL(clipUrl.current);
      clipUrl.current = url;
      url = undefined;
      setClip(prepared);
      dispatch({ type: 'reset' });
    } catch (error) {
      if (!controller.signal.aborted) {
        setMessage(error instanceof Error ? error.message : 'Could not prepare this clip.');
      }
    } finally {
      if (url) URL.revokeObjectURL(url);
      if (prepareOp.current === controller) {
        setPreparing(false);
        prepareOp.current = null;
      }
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void loadClip(signal => importReference(link, signal));
  }

  function chooseAnother() {
    prepareOp.current?.abort();
    setChecking(false);
    setClip(null);
    dispatch({ type: 'reset' });
    setFeedback(null);
    setMessage('');
    if (clipUrl.current) URL.revokeObjectURL(clipUrl.current);
    clipUrl.current = null;
  }

  function tryAgain() {
    setFeedback(null);
    setMessage('');
    dispatch({ type: 'reset' });
  }

  async function startTurn() {
    if (prepareOp.current) return;
    const controller = new AbortController();
    prepareOp.current = controller;
    setChecking(true);
    setMessage('');
    const deadline = AbortSignal.timeout(5000);
    try {
      await checkBackend(AbortSignal.any([controller.signal, deadline]));
      if (controller.signal.aborted) return;
      setFeedback(null);
      dispatch({ type: 'start', key: ++turnId.current });
    } catch (error) {
      if (!controller.signal.aborted) {
        setMessage(deadline.aborted ? 'The backend did not respond. Try again.'
          : error instanceof Error ? error.message : 'Could not check the backend.');
      }
    } finally {
      if (prepareOp.current === controller) {
        prepareOp.current = null;
        setChecking(false);
      }
    }
  }

  return (
    <main className={turn.stage === 'capture' && clip ? "solo-game solo-game--dancing" : "solo-game"}>
      <div className="solo-game__stage">
        <header className="solo-game__header">
          <div className="solo-game__brand">
            {onBack && <button className="solo-game__menu" type="button" onClick={onBack}>← Menu</button>}
          </div>
        </header>

        {!clip || turn.stage === 'ready' ? (
          <section className="solo-screen" aria-label="Dance studio">
            <div className="solo-import">
              <form onSubmit={submit} className="solo-source solo-source--top">
                <label>YouTube link
                  <input type="url" required value={link} onChange={event => setLink(event.target.value)}
                    placeholder="https://www.youtube.com/watch?v=…" disabled={preparing || checking} />
                </label>
                <div className="solo-actions">
                  <button type="submit" className="solo-primary" disabled={preparing || checking}>Prepare clip</button>
                </div>
              </form>
              <label className="solo-file">Or choose a local MP4
                <input type="file" accept="video/mp4,.mp4" disabled={preparing || checking} onChange={event => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  if (file) void loadClip(async () => file);
                }} />
              </label>
              <p className="solo-source__hint">Choose a video between 5 and 60 seconds long.</p>
              {preparing && <div className="solo-actions"><button type="button" onClick={() => prepareOp.current?.abort()}>Cancel preparation</button></div>}
              {checking && <p role="status">Checking backend…</p>}
              {message && <p role="alert">{message}</p>}
            </div>
            <div className="solo-arena"><div className="solo-arena__stage"><div className="challenge-recorder__videos">
              <div><span>Reference</span><div className="solo-reference-frame" aria-busy={preparing}>
                {clip ? <video className="challenge-recorder__reference" src={clip.videoUrl} controls playsInline />
                  : <div className="solo-reference-placeholder">{!preparing && "Choose a video to preview your dance"}</div>}
                {preparing && <div className="solo-reference-loading" role="status">
                  <strong>Preparing your dance</strong><span>Getting the video ready…</span>
                  <div className="solo-loading-track" aria-hidden="true"><div /></div>
                </div>}
              </div></div>
              <SoloCameraPreview />
            </div></div></div>
            <div className="solo-actions">
              <button type="button" className="solo-primary" disabled={!clip || preparing || checking} onClick={() => void startTurn()}>Get ready</button>
            </div>
          </section>
        ) : turn.stage === 'capture' ? (
          <section className="solo-screen" aria-labelledby="solo-turn-title">
            <div className="solo-screen__intro"><span className="solo-eyebrow">SOLO PLAY</span><h2 id="solo-turn-title">Dance along</h2><p>Follow the dancer and make the moves your own.</p></div>
            <div className="solo-arena"><div ref={attachCameraOverlay} className="solo-arena__stage solo-arena__stage--capture" data-live-rating={feedback?.score == null ? 'unavailable' : feedback.label.toLowerCase()}><ChallengeRecorder key={turn.key} reference={clip} playerId="solo"
              onFeedback={value => { setMessage(''); setFeedback(value); }}
              onComplete={attempt => dispatch({ type: 'captured', key: turn.key, attempt })}
              onError={() => setFeedback(null)} />
              {cameraOverlay && feedback && createPortal(
                <div className="solo-live-overlay" role="status" aria-label={feedback.score === null ? feedback.label : `${feedback.label}, ${feedback.score} out of 100, provisional`}>
                  <div className="dashboard-dance-feedback" key={feedback.t} aria-hidden="true"><strong>{feedback.label}</strong></div>
                  <div className="dashboard-hype-total solo-live-score" aria-hidden="true"><span>Live score</span><strong>{feedback.score === null ? '—' : Math.round(feedback.score)}</strong><span>Provisional</span></div>
                </div>, cameraOverlay)}
            </div></div>
            {message && <p role="alert">{message}</p>}
          </section>
        ) : turn.stage === 'scoring' ? (
          <section>
            <p role="status">Scoring your turn…</p>
            <button type="button" onClick={chooseAnother}>Change clip</button>
          </section>
        ) : turn.stage === 'score-error' ? (
          <section aria-labelledby="solo-score-error">
            <h2 id="solo-score-error">Could not score this turn</h2>
            <p role="alert">{message || turn.message}</p>
            <div className="solo-actions">
              <button type="button" className="solo-primary" disabled={checking} onClick={() => dispatch({ type: 'retry-score' })}>Retry score</button>
              <button type="button" disabled={checking} onClick={() => void startTurn()}>Dance again</button>
              <button type="button" onClick={chooseAnother}>Change clip</button>
            </div>
          </section>
        ) : (
          <section className="solo-screen solo-results" aria-labelledby="solo-score-title">
            <div className="solo-screen__intro"><span className="solo-eyebrow">TURN COMPLETE</span><h2 id="solo-score-title">Your score</h2><p>See how you did, then review your dance.</p></div>
            <div className="solo-result-card"><div className="solo-score"><span>OFFICIAL SCORE</span><strong>{turn.score.total}</strong><span> / 100</span></div>
            <dl className="solo-breakdown">
              {([['Arms', turn.score.arms], ['Legs', turn.score.legs], ['Torso', turn.score.torso],
                ['Timing', turn.score.timing]] as const).map(([label, value]) => (
                <div key={label}><dt>{label}</dt><dd>{value ?? 'Not scored'}</dd></div>
              ))}
            </dl>
            {turn.score.worst_part && <p>Weakest part overall: <strong>{turn.score.worst_part}</strong></p>}</div>
            <ResultsReplay key={turn.key} reference={clip} attempt={turn.attempt} score={turn.score}
              onChangeClip={chooseAnother} />
            <div className="solo-actions">
              <button type="button" className="solo-primary" onClick={tryAgain}>Try again</button>
            </div>
            {checking && <p role="status">Checking backend…</p>}
            {message && <p role="alert">{message}</p>}
          </section>
        )}
      </div>
    </main>
  );
}

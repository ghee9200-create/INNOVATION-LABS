import { useCallback, useEffect, useRef, useState } from 'react';

const CONNECTIVITY_CHECK_INTERVAL_MS = 10_000;
const CONNECTIVITY_CHECK_TIMEOUT_MS = 4_000;
const RECONNECT_CONFIRMATION_DELAY_MS = 1_500;

export default function ConnectivityGate({ children }) {
  const [status, setStatus] = useState('checking');
  const [retrying, setRetrying] = useState(false);
  const statusRef = useRef('checking');
  const probeRef = useRef(null);
  const reloadStartedRef = useRef(false);

  const updateStatus = useCallback((nextStatus) => {
    statusRef.current = nextStatus;
    setStatus(nextStatus);
  }, []);

  useEffect(() => {
    let active = true;
    let requestInFlight = false;
    let checkPending = false;
    let controller = null;
    let timeoutId = null;
    let recoveryTimeoutId = null;
    let recoverySuccesses = 0;

    const checkConnection = async (manualRetry = false) => {
      if (!active) return;
      if (requestInFlight) {
        checkPending = true;
        return;
      }
      if (!navigator.onLine) {
        recoverySuccesses = 0;
        updateStatus('offline');
        setRetrying(false);
        return;
      }

      requestInFlight = true;
      controller = new AbortController();
      timeoutId = window.setTimeout(() => controller?.abort(), CONNECTIVITY_CHECK_TIMEOUT_MS);
      try {
        const response = await fetch(`/api/health/payment?connectivityCheck=${Date.now()}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Connectivity check failed with status ${response.status}.`);
        if (!active) return;
        if (!navigator.onLine) {
          recoverySuccesses = 0;
          updateStatus('offline');
          return;
        }

        if (statusRef.current === 'offline') {
          if (!manualRetry && recoverySuccesses === 0) {
            recoverySuccesses = 1;
            recoveryTimeoutId = window.setTimeout(() => {
              recoveryTimeoutId = null;
              checkConnection();
            }, RECONNECT_CONFIRMATION_DELAY_MS);
            return;
          }
          recoverySuccesses = 0;
          if (!reloadStartedRef.current) {
            reloadStartedRef.current = true;
            window.location.reload();
          }
          return;
        }
        updateStatus('online');
      } catch {
        recoverySuccesses = 0;
        if (recoveryTimeoutId) window.clearTimeout(recoveryTimeoutId);
        recoveryTimeoutId = null;
        if (active) updateStatus('offline');
      } finally {
        window.clearTimeout(timeoutId);
        controller = null;
        timeoutId = null;
        requestInFlight = false;
        if (active) setRetrying(false);
        if (active && checkPending) {
          checkPending = false;
          checkConnection();
        }
      }
    };

    probeRef.current = checkConnection;
    checkConnection();
    const intervalId = window.setInterval(checkConnection, CONNECTIVITY_CHECK_INTERVAL_MS);
    const goOffline = () => {
      if (statusRef.current !== 'offline') reloadStartedRef.current = false;
      recoverySuccesses = 0;
      window.clearTimeout(recoveryTimeoutId);
      recoveryTimeoutId = null;
      updateStatus('offline');
    };
    const goOnline = () => checkConnection();
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);

    return () => {
      active = false;
      window.clearInterval(intervalId);
      window.clearTimeout(timeoutId);
      window.clearTimeout(recoveryTimeoutId);
      controller?.abort();
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
      probeRef.current = null;
    };
  }, [updateStatus]);

  const retry = () => {
    if (retrying) return;
    setRetrying(true);
    probeRef.current?.(true);
  };

  if (status === 'online') return children;

  if (status === 'checking') {
    return <main className="connectivity-checking" role="status" aria-live="polite">
      <span className="connectivity-spinner" aria-hidden="true" />
      <p>Checking your internet connection...</p>
    </main>;
  }

  return <main className="offline-screen">
    <section className="offline-card" aria-labelledby="offline-title">
      <div className="offline-illustration" aria-hidden="true">
        <div className="offline-board">
          <span className="offline-board-light" />
          <span className="offline-socket">
            <i />
            <i />
            <i />
          </span>
          <span className="offline-board-label">NETWORK</span>
        </div>
        <div className="offline-plug">
          <span className="offline-plug-pins"><i /><i /></span>
          <span className="offline-plug-body" />
          <span className="offline-wire"><i /><i /></span>
        </div>
        <span className="offline-cut-spark offline-cut-spark-one" />
        <span className="offline-cut-spark offline-cut-spark-two" />
        <span className="offline-illustration-glow" />
      </div>

      <p className="offline-eyebrow">INNOVATION LABS · CONNECTION STATUS</p>
      <h1 id="offline-title">NO INTERNET CONNECTION</h1>
      <p className="offline-description">Your internet connection appears to be unavailable. Please check your network connection and try again.</p>
      <button className="offline-retry-button" type="button" onClick={retry} disabled={retrying}>
        {retrying ? 'CHECKING...' : 'TRY AGAIN'}
      </button>
    </section>
  </main>;
}

// Thin wrapper around EventSource for /api/events.
export function connectEvents({ onDocChanged, onOutcome, onHello, onStatus }) {
  const es = new EventSource('/api/events');
  es.onopen = () => onStatus(true);
  es.onerror = () => onStatus(false); // EventSource auto-reconnects
  es.addEventListener('hello', (e) => onHello && onHello(JSON.parse(e.data)));
  es.addEventListener('doc-changed', (e) => onDocChanged(JSON.parse(e.data)));
  es.addEventListener('outcome', (e) => onOutcome && onOutcome(JSON.parse(e.data)));
  return es;
}

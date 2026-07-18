// Thin wrapper around EventSource for /api/events.
export function connectEvents({ onDocChanged, onStatus }) {
  const es = new EventSource('/api/events');
  es.onopen = () => onStatus(true);
  es.onerror = () => onStatus(false); // EventSource auto-reconnects
  es.addEventListener('doc-changed', (e) => onDocChanged(JSON.parse(e.data)));
  return es;
}

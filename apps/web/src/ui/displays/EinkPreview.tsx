import { useRef, useState } from 'react';
import type { ClientPlatform, ClientState } from '@our-place/client';
import type { EinkPreview as Preview, EinkPreviewRequest } from '@our-place/contracts';
import './eink.css';

export function EinkPreview({ client, state }: { client: ClientPlatform; state: ClientState }) {
  const [options, setOptions] = useState<EinkPreviewRequest>({
    layout: 'kitchen',
    includePrivate: false,
    days: 2,
    calendarIds: [],
  });
  const [image, setImage] = useState<Preview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [actual, setActual] = useState(false);
  const generation = useRef(0);
  const shared = new Set(state.session!.scopes.filter((s) => s.kind === 'shared').map((s) => s.scopeId));
  const calendars = state.agenda.calendars.filter((c) =>
    options.layout === 'kitchen'
      ? shared.has(c.scopeId) && c.context === 'home'
      : options.includePrivate || shared.has(c.scopeId),
  );
  function change(next: EinkPreviewRequest) {
    generation.current++;
    setImage(null);
    setBusy(false);
    setError('');
    setOptions(next);
  }
  async function generate() {
    if (!client.einkPreview || !state.online || busy) return;
    const current = ++generation.current;
    setBusy(true);
    setError('');
    try {
      const result = await client.einkPreview(options);
      if (generation.current === current) setImage(result);
    } catch {
      if (generation.current === current)
        setError(
          'Could not generate the preview. Reconnect and try again; Android may need the latest app update.',
        );
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }
  return (
    <details className="settings-section">
      <summary>E-ink dashboards</summary>
      <section aria-label="E-ink dashboard preview">
        <p>Preview the kitchen and desk screens. No display is connected yet.</p>
        <div className="eink-controls">
          <label>
            Dashboard
            <select
              aria-label="Dashboard layout"
              value={options.layout}
              onChange={(e) =>
                change({
                  ...options,
                  layout: e.target.value as 'kitchen' | 'desk',
                  includePrivate: false,
                  calendarIds: [],
                })
              }
            >
              <option value="kitchen">Kitchen · shared home</option>
              <option value="desk">My desk</option>
            </select>
          </label>
          <label>
            Calendar window
            <select
              aria-label="Dashboard calendar window"
              value={options.days}
              onChange={(e) => change({ ...options, days: Number(e.target.value) as 2 | 7 })}
            >
              <option value={2}>Today &amp; tomorrow</option>
              <option value={7}>Next 7 days</option>
            </select>
          </label>
        </div>
        {options.layout === 'desk' && (
          <label className="eink-check">
            <input
              type="checkbox"
              checked={options.includePrivate}
              onChange={(e) => change({ ...options, includePrivate: e.target.checked, calendarIds: [] })}
            />
            Include my private items and private calendar events
          </label>
        )}
        <fieldset className="eink-calendar-choices">
          <legend>Calendars on this screen</legend>
          {!calendars.length && <p>No eligible calendars. Add or share a calendar in Calendar settings.</p>}
          {calendars.map((c) => (
            <label className="eink-check" key={c.calendarId}>
              <input
                type="checkbox"
                checked={options.calendarIds.includes(c.calendarId)}
                onChange={(e) =>
                  change({
                    ...options,
                    calendarIds: e.target.checked
                      ? [...options.calendarIds, c.calendarId]
                      : options.calendarIds.filter((id) => id !== c.calendarId),
                  })
                }
              />
              {c.title}
            </label>
          ))}
        </fieldset>
        <button
          type="button"
          className="primary"
          disabled={busy || !state.online || !client.einkPreview}
          onClick={() => void generate()}
        >
          {busy ? 'Rendering…' : 'Generate preview'}
        </button>
        {error && <p role="alert">{error}</p>}
        {image && (
          <>
            <p className="fine">
              {image.width} × {image.height} · Black and white · Device image and preview use identical pixels
            </p>
            <label className="eink-check">
              <input type="checkbox" checked={actual} onChange={(e) => setActual(e.target.checked)} />
              Show at actual pixel size
            </label>
            <div className="eink-image">
              <img
                style={{ maxWidth: actual ? 'none' : '100%' }}
                width={image.width}
                height={image.height}
                src={`data:image/png;base64,${image.pngBase64}`}
                alt={`${options.layout === 'kitchen' ? 'Kitchen' : 'Desk'} dashboard preview`}
              />
            </div>
            {image.warnings.map((w) => (
              <p role="status" key={w}>
                {w}
              </p>
            ))}
            <div className="eink-controls">
              <a
                className="outlined-action"
                download={`${options.layout}-dashboard.bmp`}
                href={`data:image/bmp;base64,${image.bmpBase64}`}
              >
                Download 1-bit BMP
              </a>
              <a
                className="outlined-action"
                download={`${options.layout}-preview.png`}
                href={`data:image/png;base64,${image.pngBase64}`}
              >
                Download preview PNG
              </a>
            </div>
          </>
        )}
      </section>
    </details>
  );
}

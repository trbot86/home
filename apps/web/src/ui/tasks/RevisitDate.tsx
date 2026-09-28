import { useId, useRef, useState } from 'react';
import { calendarDateAt } from '@our-place/contracts';
import { displayDate } from './shared.js';

export function RevisitDate({
  value,
  targetDate,
  timeZone,
  onChange,
}: {
  value: string;
  targetDate: string;
  timeZone: string;
  onChange: (value: string) => void;
}) {
  // The native picker needs a value to choose its starting date. Keep that
  // provisional value out of the saved form until the person confirms it.
  const [draft, setDraft] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = () => {
    setDraft(null);
    trigger.current?.focus();
  };
  return (
    <div className="task-field">
      <span id={`${id}-label`}>Revisit on</span>
      <button
        ref={trigger}
        type="button"
        aria-labelledby={`${id}-label ${id}-value`}
        aria-expanded={draft !== null}
        aria-controls={draft !== null ? id : undefined}
        onClick={() => {
          if (draft !== null) close();
          else setDraft(value || targetDate || calendarDateAt(Date.now(), timeZone));
        }}
      >
        <span id={`${id}-value`}>{value ? displayDate(value) : 'Choose date'}</span>
      </button>
      {draft !== null && (
        <div
          id={id}
          role="group"
          aria-label="Choose revisit date"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
        >
          <label className="task-field">
            Revisit date selection
            <input autoFocus type="date" value={draft} onChange={(event) => setDraft(event.target.value)} />
          </label>
          <p className="fine">Use date to confirm, or cancel to keep the current date.</p>
          <div className="revisit-date-actions">
            <button
              type="button"
              onClick={() => {
                onChange(draft);
                close();
              }}
            >
              Use date
            </button>
            <button type="button" onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                onChange('');
                close();
              }}
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

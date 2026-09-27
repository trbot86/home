import { useState } from 'react';
import { addCalendarDate, type TaskOccurrence } from '@our-place/contracts';
import { displayDate } from './shared.js';
export function PostponeTask({
  item,
  today,
  disabled,
  move,
}: {
  item: TaskOccurrence;
  today: string;
  disabled: boolean;
  move: (field: 'targetDate' | 'reviewDate', value: string) => void;
}) {
  const [field, setField] = useState<'targetDate' | 'reviewDate'>('targetDate'),
    [chosen, setChosen] = useState('');
  const base = item[field] && item[field]! > today ? item[field]! : today;
  return (
    <details className="task-postpone">
      <summary>Move a date</summary>
      <div>
        <label className="task-field">
          Date to move
          <select
            aria-label="Date to move"
            value={field}
            onChange={(event) => setField(event.target.value as typeof field)}
          >
            <option value="targetDate">Flexible target</option>
            <option value="reviewDate">Revisit date</option>
          </select>
        </label>
        <p className="fine">From {displayDate(base)}. The deadline stays unchanged.</p>
        <div className="task-presets">
          {(
            [
              { count: 1, unit: 'days', label: '+1 day' },
              { count: 1, unit: 'weeks', label: '+1 week' },
              { count: 2, unit: 'weeks', label: '+2 weeks' },
              { count: 1, unit: 'months', label: '+1 month' },
            ] as const
          ).map((preset) => (
            <button
              key={preset.label}
              disabled={disabled}
              title={`Move to ${addCalendarDate(base, preset.count, preset.unit)}`}
              onClick={() => move(field, addCalendarDate(base, preset.count, preset.unit))}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <form
          className="task-custom-date"
          onSubmit={(event) => {
            event.preventDefault();
            if (chosen) move(field, chosen);
          }}
        >
          <input
            aria-label="Choose a new date"
            type="date"
            required
            value={chosen}
            disabled={disabled}
            onChange={(event) => setChosen(event.target.value)}
          />
          <button disabled={disabled || !chosen}>Set date</button>
        </form>
      </div>
    </details>
  );
}

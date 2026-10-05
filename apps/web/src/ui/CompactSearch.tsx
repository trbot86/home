import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.js';

export function CompactSearch({ label, placeholder, value, onChange }: {
  label: string; placeholder: string; value: string; onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  return <div className={`compact-search ${open || value ? 'is-open' : ''}`}>
    <button type="button" aria-label={label} aria-expanded={open || !!value}
      onClick={() => { setOpen(true); input.current?.focus(); }}><Icon name="search" size={18} /></button>
    {(open || value) && <input ref={input} type="search" aria-label={label} placeholder={placeholder}
      value={value} onChange={(event) => onChange(event.target.value)}
      onBlur={() => { if (!value) setOpen(false); }}
      onKeyDown={(event) => { if (event.key === 'Escape' && !value) { setOpen(false); event.currentTarget.parentElement?.querySelector('button')?.focus(); } }} />}
  </div>;
}

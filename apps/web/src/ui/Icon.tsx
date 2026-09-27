export function Icon({
  name,
  size = 20,
}: {
  name:
    | 'home'
    | 'food'
    | 'inbox'
    | 'shopping'
    | 'tasks'
    | 'trash'
    | 'settings'
    | 'plus'
    | 'arrow'
    | 'photo'
    | 'check'
    | 'clock'
    | 'close'
    | 'search'
    | 'lock'
    | 'refresh';
  size?: number;
}) {
  const paths = {
    home: 'M3 10 12 3l9 7v11h-6v-7H9v7H3Z',
    food: 'M4 3v5a3 3 0 0 0 6 0V3M7 3v18M17 3c-4 3-4 9 1 9V3m0 9v9',
    inbox: 'M3 4h18v16H3ZM3 13h5l2 3h4l2-3h5',
    shopping: 'M3 8h18l-2 13H5ZM7 8l3-6m7 6-3-6M9 12v5m6-5v5',
    tasks: 'M9 3h6v4H9ZM9 5H5v16h14V5h-4M8 13l3 3 5-6',
    trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
    settings:
      'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2',
    plus: 'M12 5v14M5 12h14',
    arrow: 'M5 12h14m-6-6 6 6-6 6',
    photo: 'M3 4h18v16H3Zm0 12 5-5 5 5 3-3 5 5M15 8h.01',
    check: 'm5 12 4 4 10-10',
    clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18m0 4v5l3 2',
    close: 'm6 6 12 12M6 18 18 6',
    search: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14m5 12 6 6',
    lock: 'M5 10h14v11H5ZM8 10V6a4 4 0 0 1 8 0v4',
    refresh: 'M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5m-4 6a8 8 0 0 0 14 5l3-3m0 5v-5h-5',
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

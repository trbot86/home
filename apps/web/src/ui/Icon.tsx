export function Icon({
  name,
  size = 20,
}: {
  name:
    | 'calendar'
    | 'home'
    | 'maintenance'
    | 'food'
    | 'projects'
    | 'inbox'
    | 'shopping'
    | 'tasks'
    | 'trash'
    | 'settings'
    | 'options'
    | 'plus'
    | 'arrow'
    | 'photo'
    | 'check'
    | 'clock'
    | 'close'
    | 'search'
    | 'lock'
    | 'refresh'
    | 'shared'
    | 'edit'
    | 'working'
    | 'attention'
    | 'deploy';
  size?: number;
}) {
  const paths = {
    calendar: 'M3 5h18v16H3ZM3 9h18M7 3v4m10-4v4',
    maintenance: 'M14 6a5 5 0 0 0-6 6L3 17a3 3 0 0 0 4 4l5-5a5 5 0 0 0 6-6l-3 3-4-4Z',
    shared: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M2 21v-3a7 7 0 0 1 14 0v3M17 4a4 4 0 0 1 0 8m1 3a6 6 0 0 1 4 6',
    edit: 'm4 16 12-12 4 4-12 12-5 1Zm10-10 4 4',
    working: 'm8 5-6 7 6 7m8-14 6 7-6 7M14 3l-4 18',
    attention: 'M12 3 2 21h20ZM12 9v5m0 3v1',
    deploy: 'M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6',
    home: 'M3 10 12 3l9 7v11h-6v-7H9v7H3Z',
    food: 'M4 3v5a3 3 0 0 0 6 0V3M7 3v18M17 3c-4 3-4 9 1 9V3m0 9v9',
    projects: 'M3 4h7v7H3ZM14 4h7v11h-7ZM3 15h7v6H3Zm11 4h7v2h-7Z',
    inbox: 'M3 4h18v16H3ZM3 13h5l2 3h4l2-3h5',
    shopping: 'M3 8h18l-2 13H5ZM7 8l3-6m7 6-3-6M9 12v5m6-5v5',
    tasks: 'M9 3h6v4H9ZM9 5H5v16h14V5h-4M8 13l3 3 5-6',
    trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
    settings:
      'M9 2h6l.5 3 2 1.2 2.8-1 3 5.2L21 12l2.3 1.6-3 5.2-2.8-1-2 1.2-.5 3H9l-.5-3-2-1.2-2.8 1-3-5.2L3 12 .7 10.4l3-5.2 2.8 1 2-1.2ZM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
    options: 'M3 7h10m6 0h2M3 17h2m6 0h10M16 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6M8 14a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
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

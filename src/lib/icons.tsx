/** Stroke-icon helper + the design's icon path set. */
import type { CSSProperties } from 'react';

export function I({ d, size = 14, sw = 2, fill = 'none', stroke = 'currentColor', style }: {
  d: string[]; size?: number; sw?: number; fill?: string; stroke?: string; style?: CSSProperties;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke={fill === 'none' ? stroke : 'none'} strokeWidth={sw} style={style}>
      {d.map((p, i) => <path key={i} d={p} />)}
    </svg>
  );
}

export const P = {
  chat: ['M21 12a8 8 0 01-11.5 7.2L4 20l1.3-4.2A8 8 0 1121 12z'],
  bot: ['M4 8h16v11H4z', 'M12 4v4M8.5 13v.01M15.5 13v.01M2 12v3M22 12v3'],
  folder: ['M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z'],
  market: ['M3 9l1.4-4h15.2L21 9M4 9v10h16V9M4 9h16M9 13h6'],
  gear: ['M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2', 'M12 8a4 4 0 100 8 4 4 0 000-8z'],
  search: ['M11 4a7 7 0 100 14 7 7 0 000-14', 'M21 21l-4-4'],
  plus: ['M12 5v14M5 12h14'],
  x: ['M6 6l12 12M18 6L6 18'],
  mic: ['M12 3a3 3 0 013 3v6a3 3 0 01-6 0V6a3 3 0 013-3z', 'M5 11a7 7 0 0014 0M12 18v3M8 21h8'],
  speaker: ['M4 10v4h3l4 4V6L7 10H4z', 'M15 9a4 4 0 010 6M17.5 6.5a8 8 0 010 11'],
  stopSquare: ['M7 7h10v10H7z'],
  check: ['M5 12l5 5 9-11'],
  chevD: ['M6 9l6 6 6-6'],
  chevL: ['M15 6l-6 6 6 6'],
  chevR: ['M9 6l6 6-6 6'],
  upDown: ['M8 9l4-4 4 4M8 15l4 4 4-4'],
  pin: ['M14 4l6 6-3 1-3 5-2-2-5 5-1-1 5-5-2-2 5-3z'],
  edit: ['M4 20h4L18 10l-4-4L4 16v4z', 'M14 6l4 4'],
  forkIcon: ['M6 8.5v7M8.5 6.5c6 0 6 2.5 9.5 2.5', 'M6 3.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM6 15.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM18 6.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z'],
  retry: ['M20 12a8 8 0 10-2.3 5.6M20 6v5h-5'],
  board: ['M4 5h16v14H4z', 'M8 5v14M14 9h3M14 13h3'],
  thumbUp: ['M7 11v9H4v-9zM7 11l4-8c1.5 0 2.5 1 2.5 2.5V9h5c1.2 0 2 1 1.7 2.2l-1.8 6.5c-.2.9-1 1.3-1.9 1.3H7'],
  thumbDown: ['M17 13V4h3v9zM17 13l-4 8c-1.5 0-2.5-1-2.5-2.5V15h-5c-1.2 0-2-1-1.7-2.2l1.8-6.5C5.8 5.4 6.6 5 7.5 5H17'],
  warn: ['M12 3l9 16H3z', 'M12 10v4M12 17v.5'],
  bolt: ['M13 2L3 14h7l-1 8 10-12h-7z'],
  brain: ['M12 2a7 7 0 00-4 12.7V18h8v-3.3A7 7 0 0012 2zM9 21h6'],
  attach: ['M21 12l-8.5 8.5a5 5 0 01-7-7L14 5a3.5 3.5 0 015 5l-8.5 8.5a2 2 0 01-3-3L15 7'],
  slash: ['M9 20L15 4'],
  at: ['M12 8a4 4 0 100 8 4 4 0 000-8z', 'M16 12v1.5a2.5 2.5 0 005 0V12a9 9 0 10-3.5 7.1'],
  sendArrow: ['M5 12h14M13 6l6 6-6 6'],
  clock: ['M12 3a9 9 0 100 18 9 9 0 000-18', 'M12 7v5l3 2'],
  panel: ['M4 4h16v16H4z', 'M4 9h16M9 9v11'],
  external: ['M7 17L17 7M9 7h8v8'],
  download: ['M12 3v12M8 11l4 4 4-4M4 19h16'],
  sysLines: ['M4 8h16M7 12h10M10 16h4'],
  sun: ['M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19', 'M12 8a4 4 0 100 8 4 4 0 000-8z'],
  moon: ['M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z'],
  globe: ['M12 3a9 9 0 100 18 9 9 0 000-18', 'M3 12h18', 'M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18'],
  file: ['M6 2h9l5 5v15H6z', 'M14 2v6h6'],
  /** Stacked documents: the Artifacts section (Workspace keeps the folder). */
  files: ['M8 3h8l4 4v12H8z', 'M15 3v5h5', 'M5 7v14h11'],
  /** A tray: the Inbox. */
  inbox: ['M4 13l2.5-8h11L20 13v6H4z', 'M4 13h5l1 2h4l1-2h5'],
  /** A building: the Company section. */
  building: ['M5 21V4h9v17M14 9h5v12M3 21h18', 'M8 8h3M8 12h3M8 16h3'],
  term: ['M4 5h16v14H4z', 'M7 9l3 3-3 3M13 15h4'],
  compass: ['M12 3a9 9 0 100 18 9 9 0 000-18', 'M15 9l-2 5-4 1 2-5z'],
  window: ['M4 4h16v16H4z', 'M4 9h16M9 9v11'],
  star: ['M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z'],
  shield: ['M12 3l7 4v5c0 4-3 7-7 9-4-2-7-5-7-9V7z'],
  rows: ['M4 7h16M4 12h16M4 17h10'],
  memoryIcon: ['M4 5h16v14H4z', 'M8 5v14'],
  context: ['M4 6h16v4H4zM4 14h10v4H4z'],
};

export const CAP_ICON: Record<string, string[]> = {
  file: P.file, globe: P.globe, term: P.term, compass: P.compass,
  board: P.board, edit: P.edit, clock: P.clock, window: P.window,
};

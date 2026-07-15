export type LiteIconName =
  | "arrow" | "check" | "close" | "copy" | "download" | "edit" | "eye" | "file" | "folder"
  | "globe" | "info" | "layers" | "loader" | "lock" | "plus" | "refresh" | "search"
  | "settings" | "sparkles" | "trash";

const iconPaths: Record<LiteIconName, string[]> = {
  arrow: ["M5 12h14", "m13-6 6 6-6 6"],
  check: ["m5 12 4 4L19 6"],
  close: ["M18 6 6 18", "m6 6 12 12"],
  copy: ["M9 9h11v11H9z", "M4 15V4h11"],
  download: ["M12 3v12", "m7-5 5 5 5-5", "M5 21h14"],
  edit: ["M4 20h4L19 9l-4-4L4 16z", "m13-13 4 4"],
  eye: ["M2.5 12s3.5-6 9.5-6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"],
  file: ["M6 3h8l4 4v14H6z", "M14 3v5h5", "M9 13h6", "M9 17h6"],
  folder: ["M3 6h7l2 2h9v11H3z"],
  globe: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M3 12h18", "M12 3c2.4 2.5 3.5 5.5 3.5 9S14.4 18.5 12 21c-2.4-2.5-3.5-5.5-3.5-9S9.6 5.5 12 3Z"],
  info: ["M12 11v6", "M12 7h.01", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"],
  layers: ["m12 3 9 5-9 5-9-5Z", "m3 12 9 5 9-5", "m3 16 9 5 9-5"],
  loader: ["M21 12a9 9 0 1 1-6.2-8.6"],
  lock: ["M6 10h12v10H6z", "M8 10V7a4 4 0 0 1 8 0v3"],
  plus: ["M12 5v14", "M5 12h14"],
  refresh: ["M20 7v5h-5", "M4 17v-5h5", "M6.1 9a7 7 0 0 1 11.5-2L20 12", "M4 12l2.4 5a7 7 0 0 0 11.5-2"],
  search: ["M20 20 16 16", "M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z"],
  settings: [
    "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.74v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z",
    "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  ],
  sparkles: ["m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2Z", "m19 14 .8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8Z", "m5 13 .7 2.3L8 16l-2.3.7L5 19l-.7-2.3L2 16l2.3-.7Z"],
  trash: ["M4 7h16", "M9 7V4h6v3", "m6 7 1 14h10l1-14", "M10 11v6", "M14 11v6"],
};

export function LiteIcon({ name, size = 17 }: { name: LiteIconName; size?: number }) {
  return (
    <svg
      className={name === "loader" ? "lite-loader-icon" : undefined}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {iconPaths[name].map((path) => <path d={path} key={path} />)}
    </svg>
  );
}

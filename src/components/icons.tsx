import type { SVGProps } from "react";

type Props = SVGProps<SVGSVGElement>;

function Svg({ children, ...props }: Props) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function MenuIcon(props: Props) {
  return (
    <Svg {...props}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Svg>
  );
}

export function BackIcon(props: Props) {
  return (
    <Svg {...props}>
      <path d="M15 18l-6-6 6-6" />
    </Svg>
  );
}

export function CloseIcon(props: Props) {
  return (
    <Svg {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  );
}

export function BookIcon(props: Props) {
  return (
    <Svg {...props}>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" strokeWidth="2.4" />
    </Svg>
  );
}

export function BoltIcon(props: Props) {
  return (
    <Svg {...props}>
      <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5Z" />
    </Svg>
  );
}

export function ChatIcon(props: Props) {
  return (
    <Svg {...props}>
      <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H5l-2 2V11.5A8.5 8.5 0 0 1 11.5 3h1A8.5 8.5 0 0 1 21 11.5Z" />
    </Svg>
  );
}

export function ShieldIcon(props: Props) {
  return (
    <Svg {...props}>
      <path d="M12 3 5 6v6c0 4.2 3 7.4 7 9 4-1.6 7-4.8 7-9V6l-7-3Z" />
      <path d="M12 9v4M12 16h.01" strokeWidth="2.4" />
    </Svg>
  );
}

export function KeyIcon(props: Props) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="15" r="4" />
      <path d="M10.9 12.1 19 4M18 5l2 2M15 8l2 2" />
    </Svg>
  );
}

export function ChartIcon(props: Props) {
  return (
    <Svg {...props}>
      <path d="M4 20V11M10 20V4M16 20v-6M22 20H2" />
    </Svg>
  );
}

export function ToolboxIcon(props: Props) {
  return (
    <Svg {...props}>
      <path d="M14 7V5a1 1 0 0 0-1-1h-2a1 1 0 0 0-1 1v2" />
      <rect x="3" y="7" width="18" height="12" rx="2" />
      <path d="M3 12h18" />
    </Svg>
  );
}

export function PlusIcon(props: Props) {
  return (
    <Svg {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function ArrowDownIcon(props: Props) {
  return (
    <Svg {...props}>
      <path d="M12 5v14M6 13l6 6 6-6" />
    </Svg>
  );
}

export function ArrowUpIcon(props: Props) {
  return (
    <Svg {...props}>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </Svg>
  );
}

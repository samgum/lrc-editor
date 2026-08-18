import type { ReactNode } from "react";

const LineIcon: React.FC<{ children: ReactNode; viewBox?: string }> = ({ children, viewBox = "0 0 24 24" }) => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={viewBox}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
    >
        {children}
    </svg>
);

export const BrandSVG: React.FC = () => (
    <LineIcon viewBox="0 0 32 32">
        <path className="brand-lines" d="M6 10c4-2 7 2 11 0s6-1 9 0M6 22c4-2 7 2 11 0s5-1 8 0" />
        <path className="brand-active-line" d="M10 16c4-2.5 7 2.5 11 0s4-1 5 0" />
        <circle className="brand-cue" cx="6" cy="16" r="2" fill="currentColor" stroke="none" />
    </LineIcon>
);

export const EditorSVG: React.FC = () => (
    <LineIcon>
        <path d="M5 4.5h9l4 4V20H5z" />
        <path d="M14 4.5V9h4M8 13h7M8 16.5h5" />
    </LineIcon>
);

export const SynchronizerSVG: React.FC = () => (
    <LineIcon>
        <path d="M4 6h16M4 18h16" />
        <path d="M6.5 13v-2M10 15V9M13.5 17V7M17 14v-4" />
    </LineIcon>
);

export const UtilitySVG: React.FC = () => (
    <LineIcon>
        <path d="M14.2 5.2a4.2 4.2 0 0 0-5.1 5.2L4.3 15.2a2.2 2.2 0 0 0 0 3.1l1.4 1.4a2.2 2.2 0 0 0 3.1 0l4.8-4.8a4.2 4.2 0 0 0 5.2-5.1l-3 3-2.6-.9-.9-2.6z" />
        <path d="m6.2 16.1 1.7 1.7" />
    </LineIcon>
);

export const PreferencesSVG: React.FC = () => (
    <LineIcon>
        <path d="M4 7h3M11 7h9M4 17h9M17 17h3" />
        <circle cx="9" cy="7" r="2" />
        <circle cx="15" cy="17" r="2" />
    </LineIcon>
);

export const KeyBindingsSVG: React.FC = () => (
    <LineIcon>
        <rect x="3" y="6" width="18" height="12" rx="2" />
        <path d="M6 10h2M11 10h2M16 10h2M6 14h2M11 14h7" />
    </LineIcon>
);

export const SunSVG: React.FC = () => (
    <LineIcon>
        <circle cx="12" cy="12" r="3.5" />
        <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
    </LineIcon>
);

export const MoonSVG: React.FC = () => (
    <LineIcon>
        <path d="M20 15.5A8 8 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z" />
    </LineIcon>
);

export const LoadAudioSVG: React.FC = () => (
    <LineIcon>
        <path d="M5 18V6h9l4 4v8zM14 6v4h4" />
        <path d="M9 15v-3l4-1v3" />
        <circle cx="8" cy="16" r="1.3" />
        <circle cx="12" cy="15" r="1.3" />
    </LineIcon>
);

export const PlaySVG: React.FC = () => (
    <LineIcon>
        <path d="m9 7 8 5-8 5z" />
    </LineIcon>
);

export const PauseSVG: React.FC = () => (
    <LineIcon>
        <path d="M9 7v10M15 7v10" />
    </LineIcon>
);

export const Replay5sSVG: React.FC = () => (
    <LineIcon>
        <path d="M8 8H4V4M4.7 8a8 8 0 1 1-.4 7" />
        <path d="M10 10.5h3l-2.5 3H13" />
    </LineIcon>
);

export const Forward5sSVG: React.FC = () => (
    <LineIcon>
        <path d="M16 8h4V4M19.3 8a8 8 0 1 0 .4 7" />
        <path d="M10 10.5h3l-2.5 3H13" />
    </LineIcon>
);

export const OpenFileSVG: React.FC = () => (
    <LineIcon>
        <path d="M3.5 7h7l2 2h8v10h-17z" />
        <path d="M7 14h10M12 11v6" />
    </LineIcon>
);

export const CopySVG: React.FC = () => (
    <LineIcon>
        <rect x="8" y="7" width="11" height="13" rx="1.5" />
        <path d="M16 7V4H5v13h3" />
    </LineIcon>
);

export const DownloadSVG: React.FC = () => (
    <LineIcon>
        <path d="M12 3v12M8 11l4 4 4-4M5 20h14" />
    </LineIcon>
);

export const LockSVG: React.FC = () => (
    <LineIcon>
        <path className="lock-close" d="M7 10V7a5 5 0 0 1 10 0v3" />
        <path className="lock-open" d="M8 10V7a4 4 0 0 1 7.5-2" />
        <rect x="5" y="10" width="14" height="10" rx="2" />
        <path d="M12 14v2" />
    </LineIcon>
);

export const ArrowLeftSVG: React.FC = () => (
    <LineIcon>
        <path d="m14.5 6-6 6 6 6" />
    </LineIcon>
);

export const ArrowRightSVG: React.FC = () => (
    <LineIcon>
        <path d="m9.5 6 6 6-6 6" />
    </LineIcon>
);

export const CloseSVG: React.FC = () => (
    <LineIcon>
        <path d="m6 6 12 12M18 6 6 18" />
    </LineIcon>
);

export const CheckSVG: React.FC = () => (
    <LineIcon>
        <circle cx="12" cy="12" r="9" />
        <path d="m8 12 2.5 2.5L16 9" />
    </LineIcon>
);

export const InfoSVG: React.FC = () => (
    <LineIcon>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6M12 7.5h.01" />
    </LineIcon>
);

export const ProblemSVG: React.FC = () => (
    <LineIcon>
        <path d="M12 3 2.8 20h18.4z" />
        <path d="M12 9v5M12 17h.01" />
    </LineIcon>
);

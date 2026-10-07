import { useId } from "react";

type LogoProps = {
  className?: string;
  /** Header control already names the button. The landing mark keeps a label. */
  labelled?: boolean;
};

export function Logo({ className, labelled = false }: LogoProps) {
  const clip = `rova-cap-${useId().replace(/:/g, "")}`;
  return (
    <svg
      className={className ? `block max-w-full ${className}` : "block max-w-full"}
      viewBox="0 0 1220 234"
      width="1220"
      height="234"
      fill="none"
      role={labelled ? "img" : undefined}
      aria-label={labelled ? "ROVA" : undefined}
      aria-hidden={labelled ? undefined : true}
    >
      <defs>
        <clipPath id={clip}>
          <rect width="1220" height="234" />
        </clipPath>
      </defs>
      <g fill="#fff">
        <g>
          <rect y="103" width="234" height="28" />
          <rect x="103" width="28" height="234" />
          <rect y="103" width="234" height="28" transform="rotate(45 117 117)" />
          <rect y="103" width="234" height="28" transform="rotate(-45 117 117)" />
        </g>
        <path
          fillRule="evenodd"
          d="M287 8H424A62 62 0 0 1 424 132H287ZM270 42H424A28 28 0 0 1 424 98H270Z"
        />
        <rect x="287" y="98" width="34" height="136" />
        <polygon points="358,118 430,118 500,230 428,230" />
        <circle cx="628.5" cy="117" r="99" fill="none" stroke="#fff" strokeWidth="34" />
        <g clipPath={`url(#${clip})`} fill="none" stroke="#fff" strokeWidth="38" strokeLinejoin="miter" strokeLinecap="butt">
          <polyline points="768,-36 863,230 975,-36" />
          <polyline points="963,270 1083,2 1195,270" />
        </g>
      </g>
    </svg>
  );
}

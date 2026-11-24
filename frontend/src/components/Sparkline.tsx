import { cn } from "@/lib/utils";

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  /** Stroke colour. Defaults to currentColor so callers colour it with a token class (text-info, text-live...). */
  color?: string;
  /** Area fill. Defaults to the stroke colour at low opacity. */
  fillColor?: string;
  className?: string;
}

/** Quiet trend line: thin stroke, faint area, a dot on the latest value. */
export default function Sparkline({
  data,
  width = 200,
  height = 40,
  color = "currentColor",
  fillColor,
  className,
}: SparklineProps) {
  if (data.length < 2) {
    return (
      <div style={{ width, height }} className={cn("flex items-center justify-center", className)}>
        <span className="text-xs text-muted-foreground">Pas assez de points</span>
      </div>
    );
  }

  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const padding = 2;
  const w = width - padding * 2;
  const h = height - padding * 2;

  const points = data.map((v, i) => {
    const x = padding + (i / (data.length - 1)) * w;
    const y = padding + h - ((v - min) / range) * h;
    return `${x},${y}`;
  });

  const linePath = `M${points.join(" L")}`;
  const fillPath = `${linePath} L${padding + w},${padding + h} L${padding},${padding + h} Z`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn("inline-block max-w-full", className)}
      aria-hidden
    >
      <path d={fillPath} fill={fillColor ?? color} fillOpacity={fillColor ? 1 : 0.1} />
      <path d={linePath} fill="none" stroke={color} strokeWidth="1.25" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle
        cx={padding + w}
        cy={padding + h - ((data[data.length - 1] - min) / range) * h}
        r="2"
        fill={color}
      />
    </svg>
  );
}

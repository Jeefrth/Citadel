interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  fillColor?: string;
}

export default function Sparkline({
  data,
  width = 200,
  height = 40,
  color = "#7aa2f7",
  fillColor = "rgba(122, 162, 247, 0.1)",
}: SparklineProps) {
  if (data.length < 2) {
    return (
      <div style={{ width, height }} className="flex items-center justify-center">
        <span className="text-xs text-muted-foreground">—</span>
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
    <svg width={width} height={height} className="inline-block">
      <path d={fillPath} fill={fillColor} />
      <path d={linePath} fill="none" stroke={color} strokeWidth="1.5" />
      {/* Current value dot */}
      {data.length > 0 && (
        <circle
          cx={padding + w}
          cy={padding + h - ((data[data.length - 1] - min) / range) * h}
          r="2.5"
          fill={color}
        />
      )}
    </svg>
  );
}

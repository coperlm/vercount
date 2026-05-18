"use client";
import React, { useEffect, useState } from "react";

interface Props {
  url: string;
  days?: number;
  type?: "page" | "site" | "both";
}

export default function PageViewsChart({ url, days = 30, type = "page" }: Props) {
  const [dates, setDates] = useState<string[]>([]);
  const [series, setSeries] = useState<any>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const end = new Date();
    const start = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000);
    const qs = new URLSearchParams({ url, start: start.toISOString().slice(0,10), end: end.toISOString().slice(0,10), type });
    setLoading(true);
    fetch(`/api/v2/stats?${qs.toString()}`)
      .then(r => r.json())
      .then((res) => {
        setDates(res.data?.dates || []);
        setSeries(res.data?.series || {});
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [url, days, type]);

  if (loading) return <div>Loading chart…</div>;
  if (!dates.length) return <div>No data</div>;

  // Simple SVG line chart for page_pv (falls back to site_pv)
  const values = series.page_pv?.length ? series.page_pv : series.site_pv || [];
  const max = Math.max(...values, 1);
  const width = 600;
  const height = 200;
  const padding = 30;

  const points = values.map((v: number, i: number) => {
    const x = padding + (i / Math.max(1, values.length - 1)) * (width - padding * 2);
    const y = height - padding - (v / max) * (height - padding * 2);
    return `${x},${y}`;
  }).join(" ");

  return (
    <div>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <rect x={0} y={0} width={width} height={height} fill="#f8fafc" rx={6} />
        <polyline fill="none" stroke="#2563eb" strokeWidth={2} points={points} />
      </svg>
      <div style={{ fontSize: 12, color: '#6b7280' }}>{dates[0]} → {dates[dates.length-1]}</div>
    </div>
  );
}

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface ServerMetricPoint {
  sampledAt: string;
  cpu: number;
  memory: number;
  disk: number;
}

function formatSampleTime(value: string, includeSeconds = true) {
  return new Date(value).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: includeSeconds ? "2-digit" : undefined,
  });
}

export default function ServerChart({ data }: { data: ServerMetricPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
        <CartesianGrid stroke="#e6ebe8" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="sampledAt" tickFormatter={(value) => formatSampleTime(value)} axisLine={false} tickLine={false} minTickGap={30} tick={{ fill: "#748078", fontSize: 10 }} />
        <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(value) => `${value}%`} axisLine={false} tickLine={false} tick={{ fill: "#748078", fontSize: 10 }} />
        <Tooltip labelFormatter={(value) => `采样 ${formatSampleTime(String(value), false)}`} contentStyle={{ borderColor: "#d7dfdb", borderRadius: 5, boxShadow: "0 8px 24px rgba(20, 39, 29, .12)", fontSize: 11 }} />
        <Line type="monotone" dataKey="cpu" name="CPU" unit="%" stroke="#19724a" strokeWidth={2} dot={false} activeDot={{ r: 3 }} isAnimationActive={false} />
        <Line type="monotone" dataKey="memory" name="内存" unit="%" stroke="#2c6eaa" strokeWidth={2} dot={false} activeDot={{ r: 3 }} isAnimationActive={false} />
        <Line type="monotone" dataKey="disk" name="磁盘" unit="%" stroke="#b26a16" strokeWidth={2} dot={false} activeDot={{ r: 3 }} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

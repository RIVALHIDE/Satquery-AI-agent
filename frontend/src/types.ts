export type AgentLogTag = "SYS" | "E2B" | "AGT" | "LOG" | "OUT";

export interface AgentLog {
  id: number;
  tag: AgentLogTag;
  message: string;
  timestamp: string;
}

export interface Measurement {
  label: string;
  value: string;
  color: string;
  percentage: number;
}

export interface AnalysisStep {
  id: string;
  label: string;
  detail: string;
  milliseconds: number;
  status: "done" | "running" | "pending";
}

export interface AreaContext {
  label: string;
  area: string;
}

export interface DateRange {
  from: string;
  to: string;
}

export interface MonthlyResult {
  date: string;
  scene_id: string;
  cloud_cover: number;
  metrics: Record<string, number>;
  change_from_previous: Record<string, number> | null;
  summary: string;
  thumbnail_b64: string | null;
}

export interface TimeSeriesAnalysisLog {
  tag: string;
  message: string;
}

export interface BackendTraceStep {
  tool_name: string;
  duration_ms: number;
  params: Record<string, unknown>;
  output: Record<string, unknown>;
  status: "ok" | "error";
}

export interface TimeSeriesResponse {
  status: "ok" | "error";
  query: string;
  bbox: number[];
  confidence?: number;
  metrics?: Record<string, number>;
  trace?: BackendTraceStep[];
  answer?: string;
  summary?: string;
  months: MonthlyResult[];
  overall_summary: string;
  error: string | null;
  analysis_logs?: TimeSeriesAnalysisLog[];
}

export interface WarRoomContext {
  route: string;
  query: string;
  status: "ready" | "running" | "complete" | "error";
}

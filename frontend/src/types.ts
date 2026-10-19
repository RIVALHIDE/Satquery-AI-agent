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

export interface WarRoomContext {
  route: string;
  query: string;
  status: "ready" | "running" | "complete";
}

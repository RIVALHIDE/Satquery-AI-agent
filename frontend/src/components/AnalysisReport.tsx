import { useState } from "react";
import type { Measurement, MonthlyResult } from "../types";

export interface ReportFinding {
  label: string;
  value: string;
  detail: string;
}

export interface ReportGeoJson {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: Record<string, string | number | boolean>;
    geometry: {
      type: "Polygon";
      coordinates: number[][][];
    };
  }>;
}

export interface AnalysisReportData {
  queryTitle: string;
  model: string;
  latencyMs: number;
  confidence: number;
  summary: string;
  measurements: Measurement[];
  totalArea: string;
  structureShifts: string;
  sourceScene: string;
  recommendation: string;
  findings: ReportFinding[];
  geoJson: ReportGeoJson;
  timeline?: MonthlyResult[];
}

export interface AnalysisReportProps {
  report: AnalysisReportData;
  highlighted?: boolean;
  onHighlightChange?: (highlighted: boolean) => void;
}

function inlineMarkdown(value: string) {
  const fragments = value.split(/(\*\*[^*]+\*\*)/g);
  return fragments.map((fragment, index) => {
    if (fragment.startsWith("**") && fragment.endsWith("**")) {
      return <strong key={`${fragment}-${index}`}>{fragment.slice(2, -2)}</strong>;
    }
    return <span key={`${fragment}-${index}`}>{fragment}</span>;
  });
}

function downloadFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => window.URL.revokeObjectURL(url), 0);
}

function pdfSafe(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, "?").replace(/[\\()]/g, "\\$&");
}

function percentage(value: number): string {
  return `${value.toFixed(1)}%`;
}

function timelineVegetation(result: MonthlyResult): number {
  return result.metrics.vegetation_coverage_percentage ?? 0;
}

function timelineChange(result: MonthlyResult): number {
  return result.change_from_previous?.changed_area_percentage ?? 0;
}

function buildPdf(report: AnalysisReportData): string {
  const lines = [
    "SATQUERY AI - EXECUTIVE REPORT",
    report.queryTitle,
    `Model: ${report.model}`,
    `Confidence: ${report.confidence}% verified | Latency: ${report.latencyMs} ms`,
    "",
    "EXECUTIVE SUMMARY",
    report.summary.replace(/\*\*/g, ""),
    "",
    "KEY METRICS",
    `Total area: ${report.totalArea}`,
    `Structure shifts: ${report.structureShifts}`,
    ...report.measurements.map((measurement) => `${measurement.label}: ${measurement.value}`),
    ...(report.timeline?.length
      ? [
          "",
          "MONTHLY TIMELINE",
          ...report.timeline.map((result) => `${result.date}: cloud ${percentage(result.cloud_cover)} | vegetation ${percentage(timelineVegetation(result))} | change ${percentage(timelineChange(result))}`),
        ]
      : []),
    "",
    "RECOMMENDATION",
    report.recommendation,
  ];
  const content = [
    "BT",
    "/F1 10 Tf",
    "50 760 Td",
    ...lines.flatMap((line, index) => [
      index === 0 ? `(${pdfSafe(line)}) Tj` : `0 -16 Td (${pdfSafe(line)}) Tj`,
    ]),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return pdf;
}

function reportAsText(report: AnalysisReportData): string {
  return [
    report.queryTitle,
    `Model: ${report.model}`,
    `Confidence: ${report.confidence}% verified`,
    `Latency: ${report.latencyMs} ms`,
    "",
    report.summary,
    "",
    ...report.findings.map((finding) => `${finding.label}: ${finding.value} — ${finding.detail}`),
    ...(report.timeline?.length
      ? [
          "",
          "Monthly timeline:",
          ...report.timeline.map((result) => `${result.date}: cloud ${percentage(result.cloud_cover)}, vegetation ${percentage(timelineVegetation(result))}, change ${percentage(timelineChange(result))}`),
        ]
      : []),
    "",
    `Recommendation: ${report.recommendation}`,
  ].join("\n");
}

export default function AnalysisReport({
  report,
  highlighted = false,
  onHighlightChange,
}: AnalysisReportProps) {
  const [exported, setExported] = useState<string | null>(null);

  const announceExport = (label: string) => {
    setExported(`${label} ready`);
    window.setTimeout(() => setExported(null), 2400);
  };

  const exportPdf = () => {
    downloadFile("satquery-executive-report.pdf", buildPdf(report), "application/pdf");
    announceExport("PDF export");
  };

  const exportGeoJson = () => {
    downloadFile(
      "satquery-analysis.geojson",
      JSON.stringify(report.geoJson, null, 2),
      "application/geo+json",
    );
    announceExport("GeoJSON export");
  };

  const exportRawJson = () => {
    downloadFile("satquery-analysis.json", JSON.stringify(report, null, 2), "application/json");
    announceExport("Raw JSON export");
  };

  return (
    <div className="animate-report-enter flex min-h-0 flex-1 flex-col overflow-y-auto bg-white/95 text-slate-900">
      <div className="border-b border-slate-200 px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-blue-600">AI executive report</div>
            <h2 className="mt-1 text-base font-bold leading-5 text-slate-950">{report.queryTitle}</h2>
          </div>
          <span className="shrink-0 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-[10px] font-bold text-emerald-700">
            {report.confidence}% Verified
          </span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-medium text-slate-500">
          <span>{report.model}</span>
          <span className="text-slate-300">•</span>
          <span>{report.latencyMs} ms execution</span>
          <span className="text-slate-300">•</span>
          <span>{report.sourceScene}</span>
        </div>
      </div>

      <div className="space-y-5 px-5 py-4">
        <section aria-labelledby="executive-summary-title">
          <h3 id="executive-summary-title" className="text-xs font-bold text-slate-950">Executive summary</h3>
          <p className="mt-2 text-[11px] leading-5 text-slate-600">{inlineMarkdown(report.summary)}</p>
        </section>

        {report.timeline?.length ? (
          <section aria-labelledby="monthly-timeline-title">
            <div className="flex items-center justify-between gap-3">
              <h3 id="monthly-timeline-title" className="text-xs font-bold text-slate-950">Monthly timeline</h3>
              <span className="text-[10px] font-medium text-slate-400">{report.timeline.length} observations</span>
            </div>
            <div className="mt-2 space-y-2">
              {report.timeline.map((result, index) => (
                <article key={`${result.date}-${index}`} className="flex gap-2.5 rounded-xl border border-slate-200 bg-slate-50 p-2">
                  <div className="grid h-14 w-16 shrink-0 place-items-center overflow-hidden rounded-lg border border-slate-200 bg-slate-200 text-center text-[9px] font-semibold text-slate-500">
                    {result.thumbnail_b64 ? (
                      <img
                        src={result.thumbnail_b64 ? `data:image/png;base64,${result.thumbnail_b64}` : undefined}
                        alt={`Satellite thumbnail for ${result.date}`}
                        className="h-full w-full object-cover"
                        loading="lazy"
                        onError={(event) => {
                          event.currentTarget.style.display = "none";
                        }}
                      />
                    ) : "No preview"}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] font-bold text-slate-900">{result.date}</div>
                    <dl className="mt-1.5 grid grid-cols-3 gap-1.5 text-[9px]">
                      <div>
                        <dt className="text-slate-500">Cloud</dt>
                        <dd className="font-mono font-bold text-slate-800">{percentage(result.cloud_cover)}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">Vegetation</dt>
                        <dd className="font-mono font-bold text-emerald-700">{percentage(timelineVegetation(result))}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">Change</dt>
                        <dd className="font-mono font-bold text-blue-700">{percentage(timelineChange(result))}</dd>
                      </div>
                    </dl>
                    <div className="mt-2 space-y-1" aria-label={`Progress metrics for ${result.date}`}>
                      <div className="h-1 overflow-hidden rounded-full bg-slate-200"><div className="h-full rounded-full bg-slate-500" style={{ width: `${Math.min(100, result.cloud_cover)}%` }} /></div>
                      <div className="h-1 overflow-hidden rounded-full bg-slate-200"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.min(100, timelineVegetation(result))}%` }} /></div>
                      <div className="h-1 overflow-hidden rounded-full bg-slate-200"><div className="h-full rounded-full bg-blue-600" style={{ width: `${Math.min(100, timelineChange(result))}%` }} /></div>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        <section aria-labelledby="key-findings-title">
          <div className="flex items-center justify-between gap-3">
            <h3 id="key-findings-title" className="text-xs font-bold text-slate-950">Key findings</h3>
            <span className="text-[10px] font-medium text-slate-400">scene metrics</span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {report.findings.map((finding) => (
              <div key={finding.label} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
                <div className="text-[9px] font-semibold uppercase tracking-wider text-slate-500">{finding.label}</div>
                <div className="mt-1 text-sm font-bold text-slate-950">{finding.value}</div>
                <div className="mt-1 text-[9px] leading-3.5 text-slate-500">{finding.detail}</div>
              </div>
            ))}
          </div>
        </section>

        <section aria-labelledby="land-cover-title">
          <div className="flex items-center justify-between gap-3">
            <h3 id="land-cover-title" className="text-xs font-bold text-slate-950">Land cover breakdown</h3>
            <span className="text-[10px] font-medium text-slate-400">{report.timeline?.length ? "latest observation" : "latest scene"}</span>
          </div>
          <div className="mt-3 space-y-3">
            {report.measurements.filter((measurement) => measurement.label !== "Cloud").map((measurement) => (
              <div key={measurement.label}>
                <div className="mb-1.5 flex items-center justify-between text-[11px]">
                  <span className="flex items-center gap-2 font-medium text-slate-600">
                    <span className={`h-2 w-2 rounded-full ${measurement.color}`} />
                    {measurement.label}
                  </span>
                  <span className="font-mono font-bold text-slate-900">{measurement.value}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                  <div className={`h-full rounded-full ${measurement.color} transition-all duration-700`} style={{ width: `${measurement.percentage}%` }} />
                </div>
              </div>
            ))}
          </div>
        </section>

         <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl border border-slate-200 bg-white px-3 py-2.5">
            <div className="text-[9px] font-semibold uppercase tracking-wider text-slate-500">Total area</div>
            <div className="mt-1 text-sm font-bold text-slate-950">{report.totalArea}</div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white px-3 py-2.5">
            <div className="text-[9px] font-semibold uppercase tracking-wider text-slate-500">Structure shifts</div>
            <div className="mt-1 text-sm font-bold text-slate-950">{report.structureShifts}</div>
         </div>
       </div>

        <section className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3" aria-labelledby="recommendation-title">
          <div className="flex items-start gap-2.5">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-amber-200 text-sm text-amber-800" aria-hidden="true">!</span>
            <div>
              <h3 id="recommendation-title" className="text-xs font-bold text-amber-950">Recommended next steps</h3>
              <p className="mt-1.5 text-[11px] leading-4.5 text-amber-900">{report.recommendation}</p>
            </div>
          </div>
        </section>

        <section aria-labelledby="report-actions-title">
          <div className="flex items-center justify-between gap-3">
            <h3 id="report-actions-title" className="text-xs font-bold text-slate-950">Analysis actions</h3>
            {exported ? <span role="status" className="text-[10px] font-semibold text-emerald-600">{exported}</span> : null}
          </div>
          <button
            type="button"
            aria-pressed={highlighted}
            onClick={() => onHighlightChange?.(!highlighted)}
            className={`mt-2 flex w-full items-center justify-between rounded-xl border px-3 py-2.5 text-left text-[11px] font-semibold transition ${highlighted ? "border-blue-300 bg-blue-50 text-blue-800" : "border-slate-200 bg-white text-slate-700 hover:border-blue-200 hover:bg-blue-50"}`}
          >
            <span className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${highlighted ? "bg-blue-600" : "bg-slate-300"}`} />Highlight on map</span>
            <span className={`relative h-5 w-9 rounded-full transition ${highlighted ? "bg-blue-600" : "bg-slate-300"}`} aria-hidden="true">
              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition ${highlighted ? "left-[18px]" : "left-0.5"}`} />
            </span>
          </button>

          <div className="mt-2 grid grid-cols-3 gap-2">
            <button type="button" onClick={exportPdf} className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-[10px] font-semibold text-slate-700 transition hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700">Download PDF</button>
            <button type="button" onClick={exportGeoJson} className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-[10px] font-semibold text-slate-700 transition hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700">Export GeoJSON</button>
            <button type="button" onClick={exportRawJson} className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-[10px] font-semibold text-slate-700 transition hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700">Export Raw JSON</button>
          </div>
        </section>
      </div>

      <div className="mt-auto border-t border-slate-200 px-5 py-3 text-[10px] leading-4 text-slate-500">
        Generated from the mounted scene context and available imagery results. <button type="button" onClick={() => downloadFile("satquery-report.txt", reportAsText(report), "text/plain")} className="font-semibold text-blue-700 hover:text-blue-900">Download text snapshot</button>
      </div>
    </div>
  );
}
